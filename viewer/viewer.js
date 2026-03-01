/**
 * viewer/viewer.js
 * Transcript viewer — loads a recording by ?id=, renders segments,
 * and supports inline speaker renaming.
 */

import { getRecording, updateRecording } from '../storage/storage-manager.js';
import { formatDuration, formatTimestamp } from '../utils/helpers.js';
import { getPlatformLabel } from '../utils/platform-detector.js';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const titleEl        = document.getElementById('recording-title');
const infoEl         = document.getElementById('recording-info');
const statusBadge    = document.getElementById('status-badge');
const loadingState   = document.getElementById('loading-state');
const errorState     = document.getElementById('error-state');
const errorText      = document.getElementById('error-text');
const noTranscript   = document.getElementById('no-transcript');
const transcriptBody = document.getElementById('transcript-body');
const exportToolbar  = document.getElementById('export-toolbar');
const btnExportPdf   = document.getElementById('btn-export-pdf');
const btnExportTxt   = document.getElementById('btn-export-txt');
const btnExportAudio = document.getElementById('btn-export-audio');

// ─── State ────────────────────────────────────────────────────────────────────

let recording = null;

// Ordered list of unique raw speaker labels (determines color assignment).
let speakerOrder = [];

// Speaker color palette (dark-theme friendly, 8 slots).
const SPEAKER_COLORS = [
  '#3b82f6', // blue
  '#a855f7', // purple
  '#22c55e', // green
  '#f97316', // orange
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format ms as M:SS or H:MM:SS. */
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Resolve a raw speaker label to a display name. */
function resolveSpeaker(raw) {
  return recording.speakerNames?.[raw] ?? raw;
}

/** Return a stable color for a raw speaker label. */
function speakerColor(raw) {
  const idx = speakerOrder.indexOf(raw);
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length] ?? SPEAKER_COLORS[0];
}

/** Group consecutive same-speaker segments into turns. */
function groupIntoTurns(segments) {
  const turns = [];
  for (const seg of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.segments.push(seg);
    } else {
      turns.push({ speaker: seg.speaker, segments: [seg] });
    }
  }
  return turns;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderTurn(turn) {
  const displayName = resolveSpeaker(turn.speaker);
  const color = speakerColor(turn.speaker);

  const segsHtml = turn.segments.map((seg) => {
    const lowConf = typeof seg.confidence === 'number' && seg.confidence < 0.80;
    const confPct = typeof seg.confidence === 'number'
      ? Math.round(seg.confidence * 100)
      : null;
    const confBadge = lowConf
      ? `<span class="conf-warning" title="Low confidence: ${confPct}%">&#9888;</span>`
      : '';

    return `<div class="segment${lowConf ? ' low-confidence' : ''}">
        <span class="segment-time">${formatTime(seg.start)}</span>
        <span class="segment-text">${escapeHtml(seg.text)}${confBadge}</span>
      </div>`;
  }).join('\n');

  return `<div class="turn" data-speaker="${escapeHtml(turn.speaker)}">
      <div class="turn-header">
        <button class="speaker-label" data-raw="${escapeHtml(turn.speaker)}"
                style="color: ${color}">
          ${escapeHtml(displayName)}
        </button>
      </div>
      <div class="turn-segments">${segsHtml}</div>
    </div>`;
}

function renderTranscript() {
  // Collect unique speakers in order of first appearance.
  speakerOrder = [...new Set(recording.segments.map((s) => s.speaker))];

  const turns = groupIntoTurns(recording.segments);
  transcriptBody.innerHTML = turns.map(renderTurn).join('\n');
  transcriptBody.removeAttribute('hidden');
}

// ─── Speaker renaming ─────────────────────────────────────────────────────────

transcriptBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.speaker-label');
  if (!btn) return;
  startRename(btn);
});

function startRename(btn) {
  const raw = btn.dataset.raw;
  const current = resolveSpeaker(raw);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'speaker-rename-input';
  input.setAttribute('aria-label', 'Rename speaker');

  btn.replaceWith(input);
  input.select();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    input.replaceWith(btn);
    if (newName && newName !== current) {
      applyRename(raw, newName, btn);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.replaceWith(btn); }
  });
  input.addEventListener('blur', commit);
}

async function applyRename(raw, newName, originBtn) {
  // Update in-memory state.
  if (!recording.speakerNames) recording.speakerNames = {};
  recording.speakerNames[raw] = newName;

  // Persist to IndexedDB.
  await updateRecording(recording.id, { speakerNames: recording.speakerNames });

  // Update every speaker-label button for this raw label (could span multiple turns).
  document.querySelectorAll(`.speaker-label[data-raw="${CSS.escape(raw)}"]`).forEach((btn) => {
    btn.textContent = newName;
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────

// Speaker RGB palette mirrors the CSS palette (used for PDF coloring).
const SPEAKER_RGB = [
  [59, 130, 246], [168, 85, 247], [34, 197, 94],  [249, 115, 22],
  [236, 72, 153], [20, 184, 166], [234, 179, 8],  [239, 68, 68],
];

function speakerRgb(raw) {
  const idx = speakerOrder.indexOf(raw);
  return SPEAKER_RGB[idx % SPEAKER_RGB.length] ?? SPEAKER_RGB[0];
}

// ── PDF ───────────────────────────────────────────────────────────────────────

function exportPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  const PW = doc.internal.pageSize.getWidth();   // 210
  const PH = doc.internal.pageSize.getHeight();  // 297
  const ML = 20, MR = 20, MT = 22, MB = 18;
  const CW = PW - ML - MR;                       // 170

  let y = MT;

  // ── Logo placeholder ──────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(59, 130, 246);
  doc.text('MeetRecord', ML, y);
  y += 10;

  // ── Recording title ───────────────────────────────────────────────
  const title = recording.label || recording.title || 'Untitled';
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  const titleLines = doc.splitTextToSize(title, CW);
  doc.text(titleLines, ML, y);
  y += titleLines.length * 7;

  // ── Meeting title (if distinct) ───────────────────────────────────
  if (recording.meetingTitle && recording.meetingTitle !== title) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(71, 85, 105);
    const mtLines = doc.splitTextToSize(recording.meetingTitle, CW);
    doc.text(mtLines, ML, y);
    y += mtLines.length * 6;
  }

  // ── Info line ─────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  const info = [
    formatTimestamp(recording.startTime),
    formatDuration(recording.duration ?? 0),
    getPlatformLabel(recording.platform),
  ].join('  ·  ');
  doc.text(info, ML, y);
  y += 8;

  // ── Divider ───────────────────────────────────────────────────────
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.line(ML, y, PW - MR, y);
  y += 8;

  // ── Transcript turns ──────────────────────────────────────────────
  const turns = groupIntoTurns(recording.segments);

  for (const turn of turns) {
    const displayName = resolveSpeaker(turn.speaker).toUpperCase();
    const [r, g, b] = speakerRgb(turn.speaker);

    // Page break for speaker header
    if (y + 14 > PH - MB) { doc.addPage(); y = MT; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(r, g, b);
    doc.text(displayName, ML, y);
    y += 5;

    for (const seg of turn.segments) {
      const lowConf = typeof seg.confidence === 'number' && seg.confidence < 0.80;
      const segText = `[${formatTime(seg.start)}]  ${seg.text}${lowConf ? '  (?)' : ''}`;
      const lines = doc.splitTextToSize(segText, CW - 4);

      if (y + lines.length * 4.5 > PH - MB) { doc.addPage(); y = MT; }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text(lines, ML + 4, y);
      y += lines.length * 4.5;
    }

    y += 5; // space between turns
  }

  // ── Page footer ───────────────────────────────────────────────────
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(`MeetRecord  ·  Page ${i} of ${total}`, ML, PH - 10);
  }

  const slug = (recording.label || recording.title || 'transcript').replace(/\W+/g, '_');
  doc.save(`${slug}_transcript.pdf`);
}

// ── TXT ───────────────────────────────────────────────────────────────────────

function exportTxt() {
  const title = recording.label || recording.title || 'Untitled';
  const sep = '='.repeat(60);
  const lines = [
    'MeetRecord Transcript',
    sep,
    `Title:    ${title}`,
  ];

  if (recording.meetingTitle && recording.meetingTitle !== title) {
    lines.push(`Meeting:  ${recording.meetingTitle}`);
  }

  lines.push(
    `Date:     ${formatTimestamp(recording.startTime)}`,
    `Duration: ${formatDuration(recording.duration ?? 0)}`,
    `Platform: ${getPlatformLabel(recording.platform)}`,
    sep,
    '',
  );

  const turns = groupIntoTurns(recording.segments);
  for (const turn of turns) {
    const displayName = resolveSpeaker(turn.speaker);
    for (const seg of turn.segments) {
      const lowConf = typeof seg.confidence === 'number' && seg.confidence < 0.80;
      lines.push(`${displayName} [${formatTime(seg.start)}]`);
      lines.push(`${seg.text}${lowConf ? ' (?)' : ''}`);
      lines.push('');
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const slug = (recording.label || recording.title || 'transcript').replace(/\W+/g, '_');
  a.href     = url;
  a.download = `${slug}_transcript.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function exportAudio() {
  if (!recording.blob) {
    alert('Audio blob is not available for this recording.');
    return;
  }
  const ext  = recording.mimeType?.includes('webm') ? 'webm' : 'mp4';
  const slug = (recording.label || recording.title || 'recording').replace(/\W+/g, '_');
  const url  = URL.createObjectURL(recording.blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${slug}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Button wiring ─────────────────────────────────────────────────────────────

btnExportPdf.addEventListener('click', exportPdf);
btnExportTxt.addEventListener('click', exportTxt);
btnExportAudio.addEventListener('click', exportAudio);

// ─── Loading / error states ───────────────────────────────────────────────────

function showError(msg) {
  loadingState.setAttribute('hidden', '');
  errorText.textContent = msg;
  errorState.removeAttribute('hidden');
}

function hideLoading() {
  loadingState.setAttribute('hidden', '');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  recording:   'Recording',
  processing:  'Transcribing…',
  transcribed: 'Transcribed',
  saved:       'Saved',
};

async function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');

  if (!id) {
    showError('No recording ID provided.');
    return;
  }

  recording = await getRecording(id);

  if (!recording) {
    showError('Recording not found.');
    return;
  }

  // Populate header.
  document.title = `${recording.title} — MeetRecord`;
  titleEl.textContent = recording.title;
  infoEl.textContent = [
    formatTimestamp(recording.startTime),
    formatDuration(recording.duration ?? 0),
  ].join(' · ');

  const statusLabel = STATUS_LABELS[recording.status] ?? recording.status;
  if (statusLabel) {
    statusBadge.textContent = statusLabel;
    statusBadge.className = `status-badge status-${recording.status}`;
    statusBadge.removeAttribute('hidden');
  }

  hideLoading();

  // Show export toolbar; enable PDF+TXT only when a transcript exists.
  exportToolbar.removeAttribute('hidden');
  const hasTranscript = !!recording.segments?.length;
  btnExportPdf.disabled = !hasTranscript;
  btnExportTxt.disabled = !hasTranscript;
  btnExportAudio.disabled = !recording.blob;

  if (!hasTranscript) {
    noTranscript.removeAttribute('hidden');
    return;
  }

  renderTranscript();
}

init();
