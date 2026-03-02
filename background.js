/**
 * background.js — MV3 Service Worker
 * Manages recording lifecycle, offscreen document, message routing,
 * and the AssemblyAI transcription pipeline.
 */

import { PLATFORMS, detectPlatformFromUrl } from './utils/platform-detector.js';
import { generateRecordingId } from './utils/helpers.js';
import { saveRecording, updateRecording, getRecording } from './storage/storage-manager.js';
import {
  uploadAudio,
  submitTranscriptionJob,
  fetchTranscriptResult,
  parseUtterances,
} from './transcription/assemblyai-client.js';
import { uploadRecordingToS3 } from './aws/s3-uploader.js';
import { getSession } from './auth/cognito-client.js';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  recording: false,
  recordingId: null,   // IndexedDB key for the in-progress recording
  tabId: null,
  platform: null,
  startTime: null,
  recorderTabId: null, // hidden extension tab running offscreen.js
  meetingTitle: null,  // captured from content script MEETING_DETECTED
};

// ─── Recorder Tab ─────────────────────────────────────────────────────────────

const RECORDER_URL = chrome.runtime.getURL('recorder/recorder.html');

async function ensureRecorderTab() {
  if (state.recorderTabId !== null) {
    try {
      await chrome.tabs.get(state.recorderTabId);
      return; // tab still alive
    } catch {
      state.recorderTabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url: RECORDER_URL, active: false, pinned: true });
  state.recorderTabId = tab.id;

  // Wait for the page to finish loading so offscreen.js registers its listener
  await new Promise((resolve) => {
    if (tab.status === 'complete') { resolve(); return; }
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function closeRecorderTab() {
  if (state.recorderTabId !== null) {
    await chrome.tabs.remove(state.recorderTabId).catch(() => {});
    state.recorderTabId = null;
  }
}

// ─── Recording Control ────────────────────────────────────────────────────────

async function startRecording({ tabId, captureMic = false }) {
  if (state.recording) {
    return { success: false, error: 'Already recording' };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const platform = detectPlatformFromUrl(tab.url);

    await ensureRecorderTab();

    const captureStreamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    const response = await chrome.tabs.sendMessage(state.recorderTabId, {
      type: 'OFFSCREEN_START_RECORDING',
      streamId: captureStreamId,
      captureMic,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Offscreen recorder failed to start');
    }

    state.recording = true;
    state.recordingId = generateRecordingId();
    state.tabId = tabId;
    state.platform = platform;
    state.startTime = Date.now();

    await chrome.storage.session.set({ recordingState: serializeState() });

    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED', platform }).catch(() => {});
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#e53e3e' });

    return { success: true, platform, startTime: state.startTime };
  } catch (err) {
    console.error('[BG] startRecording error:', err);
    return { success: false, error: err.message };
  }
}

async function stopRecording() {
  if (!state.recording) {
    return { success: false, error: 'Not recording' };
  }

  // Capture state before resetting
  const { recordingId, platform, tabId, startTime } = state;
  const duration = Date.now() - startTime;

  try {
    // Tell the recorder tab to stop; it returns the raw ArrayBuffer
    const offscreenResponse = await chrome.tabs.sendMessage(state.recorderTabId, { type: 'OFFSCREEN_STOP_RECORDING' });

    // Reset recording state immediately so the UI unlocks
    state.recording = false;
    state.recordingId = null;
    state.tabId = null;
    state.platform = null;
    state.startTime = null;

    await chrome.storage.session.set({ recordingState: serializeState() });
    await closeRecorderTab();

    chrome.action.setBadgeText({ text: '' });
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STOPPED' }).catch(() => {});
    }

    // Reconstruct the Blob from the transferred byte array
    const { buffer, mimeType, size } = offscreenResponse ?? {};
    if (!buffer || !size) {
      console.warn('[BG] Offscreen returned no buffer — recording may be empty');
      return { success: true, duration, platform };
    }

    const audioBuffer = new Uint8Array(buffer).buffer;
    const blob = new Blob([audioBuffer], { type: mimeType });

    // Persist the recording to IndexedDB
    await saveRecording({
      id: recordingId,
      platform,
      startTime,
      duration,
      blob,
      status: 'saved',
      meetingTitle: state.meetingTitle ?? '',
    });
    state.meetingTitle = null;

    // Kick off transcription asynchronously (does not block the response)
    triggerTranscription(recordingId, audioBuffer, mimeType).catch((err) =>
      console.error('[BG] triggerTranscription error:', err)
    );

    return { success: true, duration, platform, recordingId };
  } catch (err) {
    console.error('[BG] stopRecording error:', err);
    return { success: false, error: err.message };
  }
}

function serializeState() {
  return {
    recording: state.recording,
    recordingId: state.recordingId,
    tabId: state.tabId,
    platform: state.platform,
    startTime: state.startTime,
    meetingTitle: state.meetingTitle,
  };
}

// ─── Transcription Pipeline ───────────────────────────────────────────────────

const POLL_ALARM = 'transcription-poll';

/**
 * Upload the finished recording to AssemblyAI, submit the transcript job,
 * and register it for alarm-based polling.
 *
 * @param {string}      recordingId  IndexedDB record key.
 * @param {ArrayBuffer} audioBuffer  Raw audio bytes from the recorder.
 * @param {string}      mimeType     e.g. 'video/webm;codecs=opus'
 */
async function triggerTranscription(recordingId, audioBuffer, mimeType) {
  const { assemblyAiApiKey: apiKey, speakersExpected } = await chrome.storage.local.get({
    assemblyAiApiKey: '',
    speakersExpected: 2,
  });

  if (!apiKey) {
    console.warn('[BG] No AssemblyAI API key configured — skipping transcription');
    await updateRecording(recordingId, { status: 'no_api_key' });
    return;
  }

  try {
    // 1. Upload
    await updateRecording(recordingId, { status: 'uploading' });
    const uploadUrl = await uploadAudio(audioBuffer, apiKey);

    // 2. Submit
    await updateRecording(recordingId, { status: 'processing' });
    const transcriptId = await submitTranscriptionJob(uploadUrl, apiKey, { speakersExpected });

    // Store the transcript ID in the record so it survives a SW restart
    await updateRecording(recordingId, { transcriptId });

    // 3. Register the job for polling
    await registerPendingTranscription(transcriptId, recordingId);
  } catch (err) {
    console.error('[BG] Transcription submission failed:', err);
    await updateRecording(recordingId, {
      status: 'transcription_failed',
      transcriptionError: err.message,
    });
  }
}

/**
 * Add a job to the session-persisted pending map and ensure the polling alarm
 * is running.
 */
async function registerPendingTranscription(transcriptId, recordingId) {
  const { pendingTranscriptions = {} } = await chrome.storage.session.get('pendingTranscriptions');
  pendingTranscriptions[transcriptId] = { recordingId, submittedAt: Date.now() };
  await chrome.storage.session.set({ pendingTranscriptions });

  // Only create the alarm if it doesn't already exist
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (!existing) {
    // 1-minute interval is the production minimum; works at lower values in development
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.25 });
  }
}

/**
 * Poll all pending transcription jobs. Called by the alarm handler.
 * Updates IndexedDB and removes completed/failed jobs from the pending map.
 */
async function pollPendingTranscriptions() {
  const { pendingTranscriptions = {} } = await chrome.storage.session.get('pendingTranscriptions');
  const jobIds = Object.keys(pendingTranscriptions);

  if (jobIds.length === 0) {
    chrome.alarms.clear(POLL_ALARM);
    return;
  }

  const { assemblyAiApiKey: apiKey } = await chrome.storage.local.get({ assemblyAiApiKey: '' });
  if (!apiKey) {
    // Key was removed after jobs were submitted — mark all as failed
    for (const [transcriptId, job] of Object.entries(pendingTranscriptions)) {
      await updateRecording(job.recordingId, {
        status: 'transcription_failed',
        transcriptionError: 'API key removed',
      }).catch(() => {});
      delete pendingTranscriptions[transcriptId];
    }
    await chrome.storage.session.set({ pendingTranscriptions });
    chrome.alarms.clear(POLL_ALARM);
    return;
  }

  let changed = false;

  for (const [transcriptId, job] of Object.entries(pendingTranscriptions)) {
    try {
      const result = await fetchTranscriptResult(transcriptId, apiKey);

      if (result.status === 'completed') {
        // 4. Parse utterances into the app's segment schema
        const segments = parseUtterances(result.utterances);

        // 5. Write transcript back to the IndexedDB record
        await updateRecording(job.recordingId, {
          status: 'transcribed',
          segments,
          transcript: result.text ?? '',    // flat full-text fallback
          transcriptId,
        });

        delete pendingTranscriptions[transcriptId];
        changed = true;

        // 6. Auto-upload to S3 (runs asynchronously — does not block polling)
        triggerS3Upload(job.recordingId).catch((err) =>
          console.error('[BG] triggerS3Upload error:', err)
        );

      } else if (result.status === 'error') {
        await updateRecording(job.recordingId, {
          status: 'transcription_failed',
          transcriptionError: result.error ?? 'Unknown AssemblyAI error',
          transcriptId,
        });
        delete pendingTranscriptions[transcriptId];
        changed = true;
      }
      // 'queued' or 'processing': leave the job in the pending map
    } catch (err) {
      // Network hiccup — leave the job and retry next alarm tick
      console.error(`[BG] Poll error for transcript ${transcriptId}:`, err);
    }
  }

  if (changed) {
    await chrome.storage.session.set({ pendingTranscriptions });
  }

  if (Object.keys(pendingTranscriptions).length === 0) {
    chrome.alarms.clear(POLL_ALARM);
  }
}

// ─── S3 Upload ────────────────────────────────────────────────────────────────

/**
 * Upload a completed recording's audio and transcript to S3.
 * Called automatically after transcription reaches "completed".
 * Updates IndexedDB status: uploading → uploaded (or upload_failed).
 *
 * @param {string} recordingId  IndexedDB record key.
 */
async function triggerS3Upload(recordingId) {
  const session = await getSession();
  if (!session) {
    console.warn('[BG] No active session — skipping S3 upload for', recordingId);
    return;
  }

  const recording = await getRecording(recordingId);
  if (!recording?.blob) {
    console.warn('[BG] No blob found — skipping S3 upload for', recordingId);
    return;
  }

  try {
    await updateRecording(recordingId, { status: 'uploading' });

    const { audioUrl, transcriptUrl } = await uploadRecordingToS3(recording, session.username);

    await updateRecording(recordingId, {
      status:          'uploaded',
      s3AudioUrl:      audioUrl,
      s3TranscriptUrl: transcriptUrl,
      uploadedBy:      session.username,
      uploadedAt:      Date.now(),
    });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Upload Complete',
      message: 'Interview uploaded successfully.',
    });
  } catch (err) {
    console.error('[BG] S3 upload failed for', recordingId, err);
    await updateRecording(recordingId, {
      status:      'upload_failed',
      uploadError: err.message,
    });
  }
}

// Alarm listener — must be at top level, not inside an async function
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollPendingTranscriptions().catch((err) =>
      console.error('[BG] pollPendingTranscriptions error:', err)
    );
  }
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message;

  if (type === 'GET_STATE') {
    sendResponse(serializeState());
    return false;
  }

  if (type === 'START_RECORDING') {
    const tabId = message.tabId || sender.tab?.id;
    startRecording({ tabId, captureMic: message.captureMic }).then(sendResponse);
    return true;
  }

  if (type === 'STOP_RECORDING') {
    stopRecording().then(sendResponse);
    return true;
  }

  if (type === 'MEETING_DETECTED') {
    handleMeetingDetected(sender.tab, message);
    return false;
  }

  if (type === 'MEETING_ENDED') {
    if (state.recording && state.tabId === sender.tab?.id) {
      stopRecording().then(() => {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Recording Saved',
          message: `Your ${message.platform} meeting has been saved. Transcription starting…`,
        });
      });
    }
    return false;
  }
});

// ─── Auto-detect & Auto-record ────────────────────────────────────────────────

async function handleMeetingDetected(tab, { platform, meetingTitle, autoRecord }) {
  // Always cache the title so manual recordings can use it too.
  if (meetingTitle) state.meetingTitle = meetingTitle;

  if (!autoRecord || state.recording) return;

  const settings = await chrome.storage.local.get({ autoRecord: false });
  if (!settings.autoRecord) return;

  const result = await startRecording({ tabId: tab.id, captureMic: true });
  if (result.success) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Recording Started',
      message: `Auto-recording "${meetingTitle || platform} meeting"`,
    });
  }
}

// ─── Tab listeners ────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.recorderTabId) {
    state.recorderTabId = null;
  }
  if (state.recording && state.tabId === tabId) {
    stopRecording();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (state.recording && state.tabId === tabId && changeInfo.url) {
    if (!detectPlatformFromUrl(changeInfo.url)) {
      stopRecording();
    }
  }
});

// ─── First-run mic setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.storage.local.get({ micPermissionGranted: false }, ({ micPermissionGranted }) => {
    if (!micPermissionGranted) {
      chrome.tabs.create({ url: chrome.runtime.getURL('micsetup.html'), active: true });
    }
  });
});

// ─── Startup — restore state after SW restart ─────────────────────────────────

chrome.storage.session.get('recordingState', ({ recordingState }) => {
  if (recordingState?.recording) {
    Object.assign(state, recordingState);
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#e53e3e' });
  }
});
