/**
 * onboarding/onboarding.js
 * Setup wizard — microphone permission, configuration, and login.
 */

import { signIn } from '../auth/backend-auth.js';

// ─── State ───────────────────────────────────────────────────────────────────

let currentStep = 0;
const TOTAL_STEPS = 5;
let micGranted = false;
let loginDone = false;
let displayName = '';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const steps = Array.from(document.querySelectorAll('.step'));
const dots  = Array.from(document.querySelectorAll('.progress-dot'));
const label = document.getElementById('progress-label');

// ─── Navigation ──────────────────────────────────────────────────────────────

function goTo(index) {
  if (index < 0 || index >= TOTAL_STEPS) return;
  currentStep = index;

  steps.forEach((el, i) => el.classList.toggle('active', i === index));
  dots.forEach((el, i) => {
    el.classList.toggle('active', i === index);
    el.classList.toggle('done', i < index);
  });
  label.textContent = `Step ${index + 1} of ${TOTAL_STEPS}`;
}

function next() { goTo(currentStep + 1); }
function back() { goTo(currentStep - 1); }

// Back buttons
document.querySelectorAll('[data-back]').forEach((btn) =>
  btn.addEventListener('click', back)
);

// ─── Step 1: Welcome ─────────────────────────────────────────────────────────

document.getElementById('btn-get-started').addEventListener('click', next);

// ─── Step 2: Microphone ──────────────────────────────────────────────────────

const btnGrantMic = document.getElementById('btn-grant-mic');
const btnMicNext  = document.getElementById('btn-mic-next');
const micStatus   = document.getElementById('mic-status');

btnGrantMic.addEventListener('click', async () => {
  btnGrantMic.disabled = true;
  micStatus.innerHTML = '';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop tracks immediately — we only needed the permission grant
    stream.getTracks().forEach((t) => t.stop());

    micGranted = true;
    await chrome.storage.local.set({ micPermissionGranted: true });

    micStatus.innerHTML = '<div class="status-ok"><span class="check">&#10003;</span> Microphone access granted</div>';
    btnGrantMic.style.display = 'none';
    btnMicNext.disabled = false;
  } catch (err) {
    micStatus.innerHTML = `
      <div class="status-err">
        Microphone access was denied. Please enable it in
        <strong>Chrome Settings &gt; Privacy &gt; Site Settings &gt; Microphone</strong>
        and try again.
      </div>`;
    btnGrantMic.disabled = false;
  }
});

btnMicNext.addEventListener('click', next);

// ─── Step 3: Configuration ───────────────────────────────────────────────────

const cfgFields = {
  apiBaseUrl:       document.getElementById('cfg-api-url'),
  assemblyAiApiKey: document.getElementById('cfg-assemblyai-key'),
};
const cfgError = document.getElementById('cfg-error');

document.getElementById('btn-cfg-next').addEventListener('click', async () => {
  cfgError.textContent = '';

  const apiBaseUrl = cfgFields.apiBaseUrl.value.trim();
  if (!apiBaseUrl) {
    cfgError.textContent = 'Backend API URL is required.';
    return;
  }
  if (!apiBaseUrl.startsWith('https://') && !apiBaseUrl.startsWith('http://')) {
    cfgError.textContent = 'Backend API URL must start with https:// or http://';
    return;
  }

  await chrome.storage.local.set({
    apiBaseUrl,
    assemblyAiApiKey: cfgFields.assemblyAiApiKey.value.trim(),
  });

  next();
});

// ─── Step 4: Login ───────────────────────────────────────────────────────────

const loginEmail   = document.getElementById('login-email');
const loginPasswd  = document.getElementById('login-password');
const btnSignIn    = document.getElementById('btn-sign-in');
const loginError   = document.getElementById('login-error');
const loginWelcome = document.getElementById('login-welcome');
const btnLoginNext = document.getElementById('btn-login-next');

async function handleSignIn() {
  const email    = loginEmail.value.trim();
  const password = loginPasswd.value;
  if (!email || !password) return;

  loginError.textContent = '';
  btnSignIn.disabled     = true;
  btnSignIn.textContent  = 'Signing in…';

  try {
    const session = await signIn(email, password);
    displayName = session.displayName;
    loginDone = true;

    loginWelcome.textContent = `Welcome, ${displayName}!`;
    loginWelcome.style.display = 'flex';
    btnSignIn.style.display    = 'none';
    btnLoginNext.style.display = 'inline-flex';
  } catch (err) {
    const msg = err.message;
    if (msg === 'NOT_CONFIGURED') {
      loginError.textContent = 'Please complete Step 3 first.';
    } else if (msg === 'INVALID_CREDENTIALS') {
      loginError.textContent = 'Invalid email or password.';
    } else if (msg === 'NETWORK_ERROR') {
      loginError.textContent = 'Cannot reach the server — check the API URL.';
    } else {
      loginError.textContent = msg;
    }
  } finally {
    btnSignIn.disabled    = false;
    btnSignIn.textContent = 'Sign In';
  }
}

btnSignIn.addEventListener('click', handleSignIn);
loginPasswd.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSignIn(); });

btnLoginNext.addEventListener('click', () => {
  // Update done heading with name
  document.getElementById('done-heading').textContent = `You're all set, ${displayName}!`;
  next();
});

// ─── Step 5: Done ────────────────────────────────────────────────────────────

document.getElementById('btn-close').addEventListener('click', () => {
  window.close();
});

// ─── Pre-fill from storage (in case user revisits) ──────────────────────────

async function prefill() {
  const stored = await chrome.storage.local.get(['apiBaseUrl', 'assemblyAiApiKey']);
  if (stored.apiBaseUrl) cfgFields.apiBaseUrl.value = stored.apiBaseUrl;
  if (stored.assemblyAiApiKey) cfgFields.assemblyAiApiKey.value = stored.assemblyAiApiKey;
}

prefill();
