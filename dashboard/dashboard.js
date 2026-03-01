/**
 * dashboard/dashboard.js
 * Recordings dashboard — lists all recordings with search, tag filtering,
 * inline label editing, tag management, and per-recording actions.
 */

import { getAllRecordings, getRecording, updateRecording, deleteRecording, getSettings } from '../storage/storage-manager.js';
import { getPlatformLabel } from '../utils/platform-detector.js';
import { formatDuration, formatTimestamp, formatBytes } from '../utils/helpers.js';
import { syncRecording } from '../utils/supabase-sync.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const searchInput    = document.getElementById('search-input');
const tagBar         = document.getElementById('tag-bar');
const loadingState   = document.getElementById('loading-state');
const emptyState     = document.getElementById('empty-state');
const noResults      = document.getElementById('no-results');
const recordingsList = document.getElementById('recordings-list');
const countEl        = document.getElementById('recording-count');

// ─── State ────────────────────────────────────────────────────────────────────

let allRecordings = [];
let searchQuery   = '';
let activeTag     = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSpeakerDisplay(r) {
  if (r.speakerNames && Object.keys(r.speakerNames).length) {
    return Object.values(r.speakerNames).join(', ');
  }
  if (r.segments?.length) {
    return [...new Set(r.segments.map((s) => s.speaker))].join(', ');
  }
  return null;
}

const STATUS_LABELS = {
  saved:                'Saved',
  recording:            'Recording',
  uploading:            'Uploading…',
  transcribing:         'Transcribing…',
  processing:           'Processing…',
  transcribed:          'Transcribed',
  transcription_failed: 'Failed',
  no_api_key:           'No API Key',
};

// ─── Filtering ────────────────────────────────────────────────────────────────

function getFiltered() {
  return allRecordings.filter((r) => {
    if (activeTag && !r.tags?.includes(activeTag)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const searchable = [r.label, r.title, r.meetingTitle].filter(Boolean).join(' ').toLowerCase();
      if (!searchable.includes(q)) return false;
    }
    return true;
  });
}

// ─── Tag filter bar ───────────────────────────────────────────────────────────

function renderTagBar() {
  const allTags = [...new Set(allRecordings.flatMap((r) => r.tags ?? []))].sort();

  if (!allTags.length) {
    tagBar.setAttribute('hidden', '');
    return;
  }

  tagBar.removeAttribute('hidden');
  tagBar.innerHTML = `
    <span class="tag-filter-label">Filter:</span>
    <button class="tag-chip${activeTag === null ? ' active' : ''}" data-tag="">All</button>
    ${allTags.map((t) => `
      <button class="tag-chip${activeTag === t ? ' active' : ''}" data-tag="${escapeHtml(t)}">
        ${escapeHtml(t)}
      </button>
    `).join('')}
  `;
}

tagBar.addEventListener('click', (e) => {
  const chip = e.target.closest('.tag-chip');
  if (!chip) return;
  activeTag = chip.dataset.tag || null;
  renderTagBar();
  renderList();
});

// ─── Recording card HTML ──────────────────────────────────────────────────────

function recordingCardHtml(r) {
  const label        = r.label || r.title || 'Untitled';
  const meetingTitle = r.meetingTitle || r.title || '';
  const platform     = getPlatformLabel(r.platform);
  const date         = formatTimestamp(r.startTime);
  const dur          = formatDuration(r.duration ?? 0);
  const size         = formatBytes(r.size ?? 0);
  const status       = STATUS_LABELS[r.status] ?? (r.status ?? 'Saved');
  const speakers     = getSpeakerDisplay(r);
  const tags         = r.tags ?? [];
  const hasTranscript = !!r.segments?.length;
  const shareLabel   = r.shareUrl ? 'Copy Share Link' : 'Share';

  const tagsHtml = [
    ...tags.map((t) => `
      <span class="rec-tag">
        ${escapeHtml(t)}
        <button class="tag-remove" data-action="remove-tag" data-id="${r.id}" data-tag="${escapeHtml(t)}" title="Remove tag">&#10005;</button>
      </span>
    `),
    `<button class="add-tag-btn" data-action="add-tag" data-id="${r.id}" title="Add tag">+ tag</button>`,
  ].join('');

  const speakersHtml = speakers
    ? `<div class="rec-speakers"><strong>Speakers:</strong> ${escapeHtml(speakers)}</div>`
    : '';

  const meetingHtml = meetingTitle && meetingTitle !== label
    ? `<div class="rec-meeting-title">${escapeHtml(meetingTitle)}</div>`
    : '';

  return `
    <div class="rec-card" data-id="${r.id}">
      <div class="rec-info">
        <div class="rec-label-row">
          <span class="rec-label" data-action="edit-label" data-id="${r.id}" title="Click to edit label">
            ${escapeHtml(label)}
          </span>
        </div>

        ${meetingHtml}

        <div class="rec-meta">
          ${escapeHtml(platform)}
          <span class="sep">·</span>${date}
          <span class="sep">·</span>${dur}
          <span class="sep">·</span>${size}
        </div>

        ${speakersHtml}

        <div class="rec-tags">${tagsHtml}</div>
      </div>

      <div class="rec-aside">
        <span class="status-badge status-${r.status ?? 'saved'}">${escapeHtml(status)}</span>

        <div class="rec-actions">
          <button class="action-btn accent" data-action="view" data-id="${r.id}"
                  ${!hasTranscript ? 'disabled title="No transcript yet"' : ''}>
            &#128065; View Transcript
          </button>
          <button class="action-btn" data-action="share" data-id="${r.id}"
                  ${r.shareUrl ? 'class="action-btn accent"' : ''}>
            &#128279; ${escapeHtml(shareLabel)}
          </button>
          <button class="action-btn danger" data-action="delete" data-id="${r.id}">
            &#10005; Delete
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Render list ──────────────────────────────────────────────────────────────

function renderList() {
  const filtered = getFiltered();

  countEl.textContent = `${filtered.length} of ${allRecordings.length} recording${allRecordings.length !== 1 ? 's' : ''}`;

  emptyState.toggleAttribute('hidden', allRecordings.length !== 0);
  noResults.toggleAttribute('hidden', allRecordings.length === 0 || filtered.length !== 0);
  recordingsList.toggleAttribute('hidden', filtered.length === 0);

  if (!filtered.length) {
    recordingsList.innerHTML = '';
    return;
  }

  recordingsList.innerHTML = filtered.map(recordingCardHtml).join('');
}

// ─── Full render ──────────────────────────────────────────────────────────────

function render() {
  renderTagBar();
  renderList();
}

// ─── Event delegation ─────────────────────────────────────────────────────────

recordingsList.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id } = el.dataset;

  if (action === 'view') {
    chrome.tabs.create({ url: chrome.runtime.getURL(`viewer/viewer.html?id=${id}`) });
    return;
  }

  if (action === 'share') {
    await handleShare(id, el);
    return;
  }

  if (action === 'delete') {
    if (!confirm('Delete this recording? This cannot be undone.')) return;
    await deleteRecording(id);
    allRecordings = allRecordings.filter((r) => r.id !== id);
    render();
    return;
  }

  if (action === 'edit-label') {
    startLabelEdit(el, id);
    return;
  }

  if (action === 'add-tag') {
    startTagAdd(el, id);
    return;
  }

  if (action === 'remove-tag') {
    await removeTag(id, el.dataset.tag);
    return;
  }
});

// ─── Inline label editing ─────────────────────────────────────────────────────

function startLabelEdit(labelEl, id) {
  const current = labelEl.textContent.trim();

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'label-edit-input';

  labelEl.replaceWith(input);
  input.select();

  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    const newLabel = input.value.trim();
    input.replaceWith(labelEl);
    if (newLabel && newLabel !== current) {
      labelEl.textContent = newLabel;
      const rec = allRecordings.find((r) => r.id === id);
      if (rec) rec.label = newLabel;
      await updateRecording(id, { label: newLabel });
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(labelEl); }
  });
  input.addEventListener('blur', commit);
}

// ─── Tag add ──────────────────────────────────────────────────────────────────

function startTagAdd(addBtn, id) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-add-input';
  input.placeholder = 'tag name';

  addBtn.replaceWith(input);
  input.focus();

  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    const tag = input.value.trim().toLowerCase().replace(/\s+/g, '-');
    input.replaceWith(addBtn);
    if (tag) {
      await addTag(id, tag);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(addBtn); }
  });
  input.addEventListener('blur', commit);
}

async function addTag(id, tag) {
  const rec = allRecordings.find((r) => r.id === id);
  if (!rec) return;
  if (rec.tags?.includes(tag)) return; // no duplicates
  const tags = [...(rec.tags ?? []), tag];
  rec.tags = tags;
  await updateRecording(id, { tags });
  render();
}

async function removeTag(id, tag) {
  const rec = allRecordings.find((r) => r.id === id);
  if (!rec) return;
  const tags = (rec.tags ?? []).filter((t) => t !== tag);
  rec.tags = tags;
  await updateRecording(id, { tags });
  // Clear active tag filter if it no longer exists anywhere
  if (activeTag && !allRecordings.some((r) => r.tags?.includes(activeTag))) {
    activeTag = null;
  }
  render();
}

// ─── Share handler ────────────────────────────────────────────────────────────

async function handleShare(id, btn) {
  const rec = allRecordings.find((r) => r.id === id);
  if (!rec) return;

  if (rec.shareUrl) {
    await copyToClipboard(rec.shareUrl, btn, 'Copy Share Link');
    return;
  }

  if (!rec.segments?.length) {
    alert('This recording has no transcript yet. Transcription must complete before sharing.');
    return;
  }

  const { supabaseUrl, supabaseAnonKey } = await getSettings();
  if (!supabaseUrl || !supabaseAnonKey) {
    alert('Set your Supabase URL and anon key in the extension settings before sharing.');
    return;
  }

  // Load the full record (with blob) for upload
  const fullRec = await getRecording(id);
  if (!fullRec?.blob) {
    alert('Recording blob not found in local storage.');
    return;
  }

  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '… Uploading';

  try {
    const { shareUrl } = await syncRecording(fullRec, { supabaseUrl, supabaseAnonKey });
    await updateRecording(id, { shareUrl });
    rec.shareUrl = shareUrl;
    await copyToClipboard(shareUrl, btn, 'Copy Share Link');
  } catch (err) {
    console.error('[dashboard] Share failed:', err);
    alert(`Share failed: ${err.message}`);
    btn.textContent = origText;
  } finally {
    btn.disabled = false;
  }
}

async function copyToClipboard(text, btn, resetLabel) {
  await navigator.clipboard.writeText(text);
  const prev = btn.textContent;
  btn.textContent = '✓ Copied!';
  setTimeout(() => { btn.textContent = resetLabel ?? prev; }, 1500);
}

// ─── Search ───────────────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  renderList();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  allRecordings = await getAllRecordings();
  loadingState.setAttribute('hidden', '');
  render();
}

init();
