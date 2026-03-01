/**
 * storage/storage-manager.js
 * Manages recordings in IndexedDB with chrome.storage.sync for settings.
 */

const DB_NAME = 'MeetRecordDB';
const DB_VERSION = 1;
const STORE_RECORDINGS = 'recordings';

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const store = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        store.createIndex('platform', 'platform', { unique: false });
        store.createIndex('startTime', 'startTime', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTransaction(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Recording CRUD ───────────────────────────────────────────────────────────

/**
 * Save a completed recording.
 * @param {object} recording
 * @param {string} recording.id
 * @param {string} recording.platform
 * @param {number} recording.startTime  - epoch ms
 * @param {number} recording.duration   - ms
 * @param {Blob}   recording.blob
 * @param {string} [recording.title]
 * @param {string} [recording.transcript]
 */
export async function saveRecording(recording) {
  const record = {
    id: recording.id,
    platform: recording.platform,
    startTime: recording.startTime,
    duration: recording.duration,
    title: recording.title ?? `Recording ${new Date(recording.startTime).toLocaleString()}`,
    // User-editable label (defaults to title until changed)
    label: recording.label ?? '',
    // Meeting title captured from DOM by content scripts
    meetingTitle: recording.meetingTitle ?? '',
    // User-applied tags e.g. ['interview', 'sales']
    tags: recording.tags ?? [],
    status: recording.status ?? 'saved',
    // Structured transcript segments: { speaker, text, start, end, confidence }[]
    segments: recording.segments ?? [],
    // Flat transcript text (filled after transcription)
    transcript: recording.transcript ?? '',
    // AssemblyAI job ID — stored so polling can resume after a SW restart
    transcriptId: recording.transcriptId ?? null,
    blob: recording.blob,
    size: recording.blob?.size ?? 0,
    mimeType: recording.blob?.type ?? '',
    createdAt: Date.now(),
  };
  await dbTransaction(STORE_RECORDINGS, 'readwrite', (store) => store.put(record));
  return record;
}

/**
 * Retrieve all recordings, sorted by startTime descending.
 */
export async function getAllRecordings() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readonly');
    const store = tx.objectStore(STORE_RECORDINGS);
    const index = store.index('startTime');
    const req = index.getAll();
    req.onsuccess = () => resolve((req.result ?? []).reverse());
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get a single recording by ID.
 */
export async function getRecording(id) {
  return dbTransaction(STORE_RECORDINGS, 'readonly', (store) => store.get(id));
}

/**
 * Delete a recording by ID.
 */
export async function deleteRecording(id) {
  return dbTransaction(STORE_RECORDINGS, 'readwrite', (store) => store.delete(id));
}

/**
 * Patch specific fields on an existing recording without overwriting the whole record.
 * Uses a get-then-put within a single transaction to avoid a race condition.
 * @param {string} id
 * @param {object} patches  Plain object of fields to merge in.
 * @returns {Promise<object>}  The updated record.
 */
export async function updateRecording(id, patches) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);

    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) {
        reject(new Error(`updateRecording: record "${id}" not found`));
        return;
      }
      const updated = { ...record, ...patches };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };

    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Total storage used by all recordings.
 */
export async function getStorageStats() {
  const recordings = await getAllRecordings();
  const totalSize = recordings.reduce((sum, r) => sum + (r.size ?? 0), 0);
  return { count: recordings.length, totalSize };
}

// ─── Settings (chrome.storage.sync) ──────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoRecord: false,
  recordAudio: true,
  recordVideo: true,
  storageLimit: 500, // MB
  notifyOnStart: true,
  notifyOnStop: true,
  cloudSync: false,
  cloudProvider: null,
  // Transcription
  assemblyAiApiKey: '',
  speakersExpected: 2,   // default for interviews (interviewer + candidate)
  // Cloud sharing (Prompt 4)
  supabaseUrl: '',
  supabaseAnonKey: '',
};

export async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

export async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

export async function resetSettings() {
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
}

// ─── Export helpers ───────────────────────────────────────────────────────────

/**
 * Export a recording blob as a downloadable file.
 * (Called from the popup / recordings page.)
 */
export function exportRecordingBlob(recording) {
  const ext = recording.mimeType?.includes('webm') ? 'webm' : 'mp4';
  const filename = `${recording.title.replace(/\W+/g, '_')}.${ext}`;
  const url = URL.createObjectURL(recording.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Export transcript as a plain-text file.
 */
export function exportTranscript(recording) {
  const text = recording.transcript || '(No transcript)';
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${recording.title.replace(/\W+/g, '_')}_transcript.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
