require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3000;
const S3_BUCKET        = process.env.S3_BUCKET || 'meetrecord-recordings';
const AUTH_MODE        = process.env.AUTH_MODE || 'simple';
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'change-me';
const TOKEN_EXPIRY     = '24h';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-north-1' });

const app = express();
app.use(cors());
app.use(express.json());

// ─── Auth helpers ────────────────────────────────────────────────────────────

async function authenticateSimple(username, password) {
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const userId = username;
    const displayName = process.env.ADMIN_DISPLAY_NAME || username;
    const token = jwt.sign({ userId, displayName }, AUTH_TOKEN_SECRET, {
      expiresIn: TOKEN_EXPIRY,
    });
    const decoded = jwt.decode(token);
    return {
      token,
      expiresAt: decoded.exp * 1000, // milliseconds
      userId,
      displayName,
    };
  }
  return null;
}

async function authenticateKeycloak(username, password) {
  const url =
    `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.KEYCLOAK_CLIENT_ID,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET || '',
    username,
    password,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  const decoded = jwt.decode(data.access_token);

  return {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    userId: decoded?.preferred_username || decoded?.sub || username,
    displayName: decoded?.name || decoded?.preferred_username || username,
  };
}

// ─── Token verification middleware ───────────────────────────────────────────

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  if (AUTH_MODE === 'simple') {
    try {
      const payload = jwt.verify(token, AUTH_TOKEN_SECRET);
      req.user = { userId: payload.userId, displayName: payload.displayName };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // Keycloak — decode without verification (Keycloak already signed it;
  // for production, verify against Keycloak's JWKS endpoint)
  try {
    const payload = jwt.decode(token);
    if (!payload || (payload.exp && payload.exp * 1000 < Date.now())) {
      return res.status(401).json({ error: 'Token expired' });
    }
    req.user = {
      userId: payload.preferred_username || payload.sub,
      displayName: payload.name || payload.preferred_username || payload.sub,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /auth/token
app.post('/auth/token', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const result = AUTH_MODE === 'keycloak'
      ? await authenticateKeycloak(username, password)
      : await authenticateSimple(username, password);

    if (!result) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    return res.json(result);
  } catch (err) {
    console.error('[auth] Error:', err.message);
    return res.status(500).json({ error: 'Authentication service error' });
  }
});

// POST /upload-url — generate pre-signed S3 PUT URLs
app.post('/upload-url', verifyToken, async (req, res) => {
  const { recordingId, contentType } = req.body || {};
  if (!recordingId) {
    return res.status(400).json({ error: 'recordingId is required' });
  }

  try {
    const audioKey = `recordings/${req.user.userId}/${recordingId}.webm`;
    const transcriptKey = `transcripts/${req.user.userId}/${recordingId}.json`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: audioKey,
        ContentType: contentType || 'audio/webm',
        Metadata: { userId: req.user.userId },
      }),
      { expiresIn: 900 } // 15 minutes
    );

    const transcriptUploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: transcriptKey,
        ContentType: 'application/json',
        Metadata: { userId: req.user.userId },
      }),
      { expiresIn: 900 }
    );

    return res.json({ uploadUrl, transcriptUploadUrl });
  } catch (err) {
    console.error('[upload-url] Error:', err.message);
    return res.status(500).json({ error: 'Failed to generate upload URLs' });
  }
});

// GET /recordings/list — list all transcripts from S3
app.get('/recordings/list', verifyToken, async (req, res) => {
  try {
    const listResp = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: 'transcripts/',
      })
    );

    const contents = listResp.Contents || [];
    const jsonKeys = contents.filter((obj) => obj.Key.endsWith('.json'));

    const recordings = await Promise.all(
      jsonKeys.map(async (obj) => {
        try {
          const data = await s3.send(
            new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key })
          );
          const body = await data.Body.transformToString();
          const transcript = JSON.parse(body);
          return {
            recordingId: transcript.recordingId,
            label: transcript.label || '',
            date: transcript.date || '',
            duration: transcript.duration || 0,
            uploadedBy: transcript.uploadedBy || '',
            status: 'uploaded',
          };
        } catch (err) {
          console.error(`[list] Failed to read ${obj.Key}:`, err.message);
          return null;
        }
      })
    );

    return res.json(
      recordings.filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date))
    );
  } catch (err) {
    console.error('[list] Error:', err.message);
    return res.status(500).json({ error: 'Failed to list recordings' });
  }
});

// Helper: find transcript key across all user prefixes
async function findTranscriptKey(recordingId) {
  const listResp = await s3.send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'transcripts/',
    })
  );
  const match = (listResp.Contents || []).find((obj) =>
    obj.Key.endsWith(`/${recordingId}.json`)
  );
  return match ? match.Key : null;
}

// GET /recordings/:recordingId — fetch single transcript
app.get('/recordings/:recordingId', verifyToken, async (req, res) => {
  const { recordingId } = req.params;

  try {
    const key = await findTranscriptKey(recordingId);
    if (!key) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    const data = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })
    );
    const body = await data.Body.transformToString();
    const transcript = JSON.parse(body);
    return res.json(transcript);
  } catch (err) {
    console.error('[get] Error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch recording' });
  }
});

// PUT /recordings/:recordingId — update transcript (speakerMap, label)
app.put('/recordings/:recordingId', verifyToken, async (req, res) => {
  const { recordingId } = req.params;
  const updates = req.body || {};

  try {
    const key = await findTranscriptKey(recordingId);
    if (!key) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    // Fetch existing
    const data = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })
    );
    const body = await data.Body.transformToString();
    const transcript = JSON.parse(body);

    // Merge updates
    if (updates.speakerMap) {
      transcript.speakerMap = updates.speakerMap;
    }
    if (updates.label !== undefined) {
      transcript.label = updates.label;
    }

    // Write back
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: JSON.stringify(transcript),
        ContentType: 'application/json',
      })
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('[put] Error:', err.message);
    return res.status(500).json({ error: 'Failed to update recording' });
  }
});

// ─── Error handler ───────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`MeetRecord backend running on http://localhost:${PORT}`);
  console.log(`Auth mode: ${AUTH_MODE}`);
});
