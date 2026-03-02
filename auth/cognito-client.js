/**
 * auth/cognito-client.js
 * AWS Cognito USER_PASSWORD_AUTH flow via direct REST calls.
 * No SDK required — works inside a Chrome extension service worker and popup.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function cognitoRequest(region, clientId, target, params) {
  const resp = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify({ ClientId: clientId, ...params }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(text);

  return JSON.parse(text);
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

function extractUserInfo(idToken, email) {
  const p = decodeJwtPayload(idToken);
  const displayName = p.name || p.given_name || p['cognito:username'] || p.email || email;
  const username    = p['cognito:username'] || p.sub || email;
  return { displayName, username };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getAuthConfig() {
  return chrome.storage.local.get({ cognitoRegion: '', cognitoClientId: '' });
}

// ─── Sign in ──────────────────────────────────────────────────────────────────

export async function signIn(email, password) {
  const { cognitoRegion, cognitoClientId } = await getAuthConfig();
  if (!cognitoRegion || !cognitoClientId) {
    throw new Error('Cognito not configured. Set Region and Client ID in Settings.');
  }

  const data = await cognitoRequest(cognitoRegion, cognitoClientId, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });

  // Handle first-login password-change challenge (admin-created users).
  let authResult = data.AuthenticationResult;
  if (!authResult && data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    const challengeData = await cognitoRequest(cognitoRegion, cognitoClientId, 'RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: password },
      Session: data.Session,
    });
    authResult = challengeData.AuthenticationResult;
  }

  if (!authResult) {
    throw new Error(`Sign-in failed — no token returned. Full response: ${JSON.stringify(data)}`);
  }

  const { IdToken, AccessToken, RefreshToken, ExpiresIn } = authResult;

  const { displayName, username } = extractUserInfo(IdToken, email);
  const expiry = Date.now() + (ExpiresIn ?? 3600) * 1000;

  await chrome.storage.local.set({
    cognitoIdToken:      IdToken,
    cognitoAccessToken:  AccessToken,
    cognitoRefreshToken: RefreshToken,
    cognitoExpiry:       expiry,
    cognitoUsername:     username,
    cognitoDisplayName:  displayName,
  });

  return { username, displayName };
}

// ─── Sign out ─────────────────────────────────────────────────────────────────

export async function signOut() {
  await chrome.storage.local.remove([
    'cognitoIdToken',
    'cognitoAccessToken',
    'cognitoRefreshToken',
    'cognitoExpiry',
    'cognitoUsername',
    'cognitoDisplayName',
  ]);
}

// ─── Get current session ──────────────────────────────────────────────────────

/**
 * Returns session object if a token is stored, otherwise null.
 * Does not check expiry — if the token is stale, API calls will fail
 * and the user can re-login at that point.
 */
export async function getSession() {
  const stored = await chrome.storage.local.get({
    cognitoIdToken:     null,
    cognitoAccessToken: null,
    cognitoUsername:    null,
    cognitoDisplayName: null,
  });

  if (!stored.cognitoIdToken) return null;

  return {
    idToken:     stored.cognitoIdToken,
    accessToken: stored.cognitoAccessToken,
    username:    stored.cognitoUsername,
    displayName: stored.cognitoDisplayName,
  };
}

