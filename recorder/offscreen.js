/**
 * recorder/offscreen.js
 * Runs inside the offscreen document (recorder/offscreen.html).
 *
 * Flow:
 *  1. background.js calls chrome.tabCapture.getMediaStreamId and sends the
 *     streamId here via OFFSCREEN_START_RECORDING.
 *  2. We call getUserMedia with chromeMediaSource:'tab' to get the tab's
 *     audio (and video, which Chrome requires to activate the audio pipeline).
 *  3. If captureMic is true we also call getUserMedia for the microphone.
 *  4. Both audio sources are mixed into a single destination via AudioContext.
 *  5. MediaRecorder records the mixed audio stream.
 */

let mediaRecorder = null;
let recordedChunks = [];
let tabStream  = null;   // chromeMediaSource:'tab' stream
let micStream  = null;   // microphone stream
let audioCtx   = null;   // AudioContext used for mixing
let monitorCtx = null;   // AudioContext used for speaker monitoring

// ─── MIME type ────────────────────────────────────────────────────────────────

function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm';
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function startRecording({ streamId, captureMic = false }) {
  if (mediaRecorder?.state === 'recording') {
    return { success: false, error: 'Already recording' };
  }

  try {
    // Chrome requires video:true in the constraints even when only audio is
    // needed — without it the tab's audio pipeline never activates.
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    // Video tracks were required to activate Chrome's audio pipeline but are
    // not recorded — stop them immediately to free the capture resource.
    tabStream.getVideoTracks().forEach((t) => t.stop());

    // Play tab audio back through the speakers so the user can still hear the meeting.
    monitorCtx = new AudioContext();
    const source = monitorCtx.createMediaStreamSource(tabStream);
    source.connect(monitorCtx.destination);

    recordedChunks = [];

    let recordStream;

    if (captureMic) {
      // ── Mix tab audio + microphone ─────────────────────────────────────────
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
        },
        video: false,
      });

      audioCtx = new AudioContext();
      const destination = audioCtx.createMediaStreamDestination();

      // Tab audio → destination
      audioCtx.createMediaStreamSource(
        new MediaStream(tabStream.getAudioTracks())
      ).connect(destination);

      // Microphone → destination
      audioCtx.createMediaStreamSource(micStream).connect(destination);

      recordStream = destination.stream;
    } else {
      // ── Tab audio only ────────────────────────────────────────────────────
      recordStream = new MediaStream(tabStream.getAudioTracks());
    }

    const mimeType = getSupportedMimeType();
    mediaRecorder = new MediaRecorder(recordStream, {
      mimeType,
      audioBitsPerSecond: 128_000,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onerror = (e) => {
      console.error('[Offscreen] MediaRecorder error:', e.error);
    };

    mediaRecorder.start(5000);
    return { success: true, mimeType };
  } catch (err) {
    console.error('[Offscreen] startRecording error:', err);
    cleanup();
    return { success: false, error: err.message };
  }
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanup();
      resolve({ success: true, buffer: null, size: 0 });
      return;
    }

    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(recordedChunks, { type: mimeType });
      cleanup();
      blob.arrayBuffer().then((buf) => {
        resolve({
          success: true,
          buffer: Array.from(new Uint8Array(buf)),
          mimeType,
          size: blob.size,
        });
      });
    };

    mediaRecorder.stop();
  });
}

// ─── Pause / Resume ───────────────────────────────────────────────────────────

function pauseRecording() {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.pause();
    return { success: true };
  }
  return { success: false, error: 'Not recording' };
}

function resumeRecording() {
  if (mediaRecorder?.state === 'paused') {
    mediaRecorder.resume();
    return { success: true };
  }
  return { success: false, error: 'Not paused' };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup() {
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  monitorCtx?.close();
  tabStream      = null;
  micStream      = null;
  audioCtx       = null;
  monitorCtx     = null;
  mediaRecorder  = null;
  recordedChunks = [];
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'OFFSCREEN_START_RECORDING':
      startRecording(message).then(sendResponse);
      return true;
    case 'OFFSCREEN_STOP_RECORDING':
      stopRecording().then(sendResponse);
      return true;
    case 'OFFSCREEN_PAUSE_RECORDING':
      sendResponse(pauseRecording());
      return false;
    case 'OFFSCREEN_RESUME_RECORDING':
      sendResponse(resumeRecording());
      return false;
  }
});
