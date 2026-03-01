/**
 * popup/popup.js
 * Popup controller — renders state, handles recording controls and settings.
 */

import { formatDuration, formatTimestamp, formatBytes } from '../utils/helpers.js';
import { getAllRecordings, getRecording, updateRecording, deleteRecording, exportRecordingBlob, exportTranscript, getSettings, saveSettings } from '../storage/storage-manager.js';
import { getPlatformLabel } from '../utils/platform-detector.js';
import { syncRecording } from '../utils/supabase-sync.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const timerEl       = document.getElementById('timer');
const platformBadge = document.getElementById('platform-badge');
const btnRecord     = document.getElementById('btn-record');
const btnLabel      = document.getElementById('btn-record-label');
const desktopToggle = document.getElementById('desktop-capture-toggle');
const recordingsList = document.getElementById('recordings-list');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel  = document.getElementById('settings-panel');
const mainPanel      = document.getElementById('main-panel');
const dashboardBtn   = document.getElementById('dashboard-btn');

// Settings fields
const sAutoRecord    = document.getElementById('setting-auto-record');
const sRecordAudio   = document.getElementById('setting-record-audio');
const sRecordVideo   = document.getElementById('setting-record-video');
const sNotify        = document.getElementById('setting-notify');
const sStorageLimit  = document.getElementById('setting-storage-limit');
const sSupabaseUrl   = document.getElementById('setting-supabase-url');
const sSupabaseKey   = document.getElementById('setting-supabase-key');
const btnSaveSettings = document.getElementById('btn-save-settings');

// ─── State ────────────────────────────────────────────────────────────────────

let timerInterval = null;
let recordingStartTime = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendBg(type, extra = {}) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage({ type, ...extra }, resolve)
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function startTimer(startTime) {
  recordingStartTime = startTime;
  timerEl.removeAttribute('hidden');
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timerEl.textContent = formatDuration(Date.now() - recordingStartTime);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  recordingStartTime = null;
  timerEl.setAttribute('hidden', '');
  timerEl.textContent = '00:00:00';
}

// ─── UI state sync ────────────────────────────────────────────────────────────

function applyRecordingState({ recording, platform, startTime }) {
  if (recording) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Recording';
    btnLabel.textContent = 'Stop Recording';
    btnRecord.classList.replace('btn-primary', 'btn-danger');
    document.querySelector('.btn-icon').textContent = '⏹';
    startTimer(startTime);

    if (platform) {
      platformBadge.textContent = getPlatformLabel(platform);
      platformBadge.removeAttribute('hidden');
    }
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Not Recording';
    btnLabel.textContent = 'Start Recording';
    btnRecord.classList.replace('btn-danger', 'btn-primary');
    document.querySelector('.btn-icon').textContent = '▶';
    stopTimer();
    platformBadge.setAttribute('hidden', '');
  }
}

// ─── Recordings list ──────────────────────────────────────────────────────────

async function renderRecordings() {
  const recordings = await getAllRecordings();
  if (recordings.length === 0) {
    recordingsList.innerHTML = '<p class="empty-state">No recordings yet.</p>';
    return;
  }

  recordingsList.innerHTML = recordings
    .slice(0, 10) // Show last 10
    .map((r) => {
      const date = formatTimestamp(r.startTime);
      const dur  = formatDuration(r.duration ?? 0);
      const size = formatBytes(r.size ?? 0);
      const platform = getPlatformLabel(r.platform);
      const hasShare = !!r.shareUrl;
      return `
        <div class="recording-item" data-id="${r.id}">
          <div>
            <div class="recording-item-title" title="${r.title}">${r.title}</div>
            <div class="recording-item-meta">${platform} · ${date} · ${dur} · ${size}</div>
          </div>
          <div class="recording-item-actions">
            <button class="icon-btn-sm" data-action="view" data-id="${r.id}" title="View transcript">&#128065;</button>
            <button class="icon-btn-sm${hasShare ? ' shared' : ''}" data-action="share" data-id="${r.id}" title="${hasShare ? 'Copy share link' : 'Share recording'}">&#128279;</button>
            <button class="icon-btn-sm" data-action="download" data-id="${r.id}" title="Download">&#8681;</button>
            <button class="icon-btn-sm" data-action="transcript" data-id="${r.id}" title="Export transcript">&#128196;</button>
            <button class="icon-btn-sm danger" data-action="delete" data-id="${r.id}" title="Delete">&#10005;</button>
          </div>
        </div>
      `;
    })
    .join('');
}

recordingsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'view') {
    chrome.tabs.create({ url: chrome.runtime.getURL(`viewer/viewer.html?id=${id}`) });
    return;
  }

  if (action === 'share') {
    await handleShare(id, btn);
    return;
  }

  if (action === 'delete') {
    if (!confirm('Delete this recording?')) return;
    await deleteRecording(id);
    renderRecordings();
  }

  if (action === 'download' || action === 'transcript') {
    const rec = await getRecording(id);
    if (!rec) return;
    action === 'download' ? exportRecordingBlob(rec) : exportTranscript(rec);
  }
});

// ─── Share handler ────────────────────────────────────────────────────────────

async function handleShare(id, btn) {
  const rec = await getRecording(id);
  if (!rec) return;

  // Already synced — just copy the existing link.
  if (rec.shareUrl) {
    await copyToClipboard(rec.shareUrl, btn);
    return;
  }

  // Need a transcript to share.
  if (!rec.segments?.length) {
    alert('This recording has no transcript yet. Wait for transcription to complete before sharing.');
    return;
  }

  const { supabaseUrl, supabaseAnonKey } = await getSettings();
  if (!supabaseUrl || !supabaseAnonKey) {
    alert('Set your Supabase URL and anon key in Settings before sharing.');
    return;
  }

  // Show loading state while uploading.
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const { shareUrl } = await syncRecording(rec, { supabaseUrl, supabaseAnonKey });
    await updateRecording(id, { shareUrl });
    btn.classList.add('shared');
    btn.title = 'Copy share link';
    await copyToClipboard(shareUrl, btn);
  } catch (err) {
    console.error('[popup] Share failed:', err);
    alert(`Share failed: ${err.message}`);
    btn.innerHTML = originalHtml;
  } finally {
    btn.disabled = false;
  }
}

async function copyToClipboard(text, btn) {
  await navigator.clipboard.writeText(text);
  if (btn) {
    const prev = btn.innerHTML;
    btn.textContent = '✓';
    setTimeout(() => { btn.innerHTML = prev; }, 1500);
  }
}

// ─── Record button ────────────────────────────────────────────────────────────

btnRecord.addEventListener('click', async () => {
  btnRecord.disabled = true;
  const state = await sendBg('GET_STATE');

  if (state?.recording) {
    await sendBg('STOP_RECORDING');
    await renderRecordings();
  } else {
    const tab = await getActiveTab();
    const result = await sendBg('START_RECORDING', {
      tabId: tab.id,
      useDesktopCapture: desktopToggle.checked,
    });
    if (!result?.success) {
      alert(`Failed to start recording: ${result?.error ?? 'Unknown error'}`);
    }
  }

  // Re-sync UI
  const newState = await sendBg('GET_STATE');
  applyRecordingState(newState ?? {});
  btnRecord.disabled = false;
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  const showing = !settingsPanel.hasAttribute('hidden');
  settingsPanel.toggleAttribute('hidden', showing);
  mainPanel.toggleAttribute('hidden', !showing);
});

async function loadSettings() {
  const s = await getSettings();
  sAutoRecord.checked    = s.autoRecord;
  sRecordAudio.checked   = s.recordAudio;
  sRecordVideo.checked   = s.recordVideo;
  sNotify.checked        = s.notifyOnStart;
  sStorageLimit.value    = s.storageLimit;
  sSupabaseUrl.value     = s.supabaseUrl ?? '';
  sSupabaseKey.value     = s.supabaseAnonKey ?? '';
}

btnSaveSettings.addEventListener('click', async () => {
  await saveSettings({
    autoRecord:      sAutoRecord.checked,
    recordAudio:     sRecordAudio.checked,
    recordVideo:     sRecordVideo.checked,
    notifyOnStart:   sNotify.checked,
    notifyOnStop:    sNotify.checked,
    storageLimit:    parseInt(sStorageLimit.value, 10),
    supabaseUrl:     sSupabaseUrl.value.trim(),
    supabaseAnonKey: sSupabaseKey.value.trim(),
  });
  btnSaveSettings.textContent = 'Saved!';
  setTimeout(() => (btnSaveSettings.textContent = 'Save Settings'), 1500);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [state] = await Promise.all([
    sendBg('GET_STATE'),
    loadSettings(),
    renderRecordings(),
  ]);
  applyRecordingState(state ?? {});
}

init();
