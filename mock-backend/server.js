const http = require('http');

const PORT = 3000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ─── Mock data ───────────────────────────────────────────────────────────────

const RECORDINGS_LIST = [
  {
    recordingId: 'rec-001',
    label: 'Interview — Jane Smith',
    date: '2025-03-01T10:00:00Z',
    duration: 2700000,
    uploadedBy: 'test-user-1',
    status: 'uploaded',
  },
  {
    recordingId: 'rec-002',
    label: 'Interview — John Doe',
    date: '2025-03-02T14:00:00Z',
    duration: 3600000,
    uploadedBy: 'test-user-1',
    status: 'uploaded',
  },
];

function makeTranscript(id) {
  return {
    recordingId: id,
    label: 'Interview — Test Candidate',
    date: '2025-03-01T10:00:00Z',
    duration: 2700000,
    uploadedBy: 'test-user-1',
    speakerMap: { Speaker_A: 'Interviewer', Speaker_B: 'Candidate' },
    segments: [
      { speaker: 'Speaker_A', text: 'Tell me about yourself.', start: 1000, end: 4000 },
      { speaker: 'Speaker_B', text: 'Sure, I have 5 years of experience in product.', start: 4500, end: 8000 },
      { speaker: 'Speaker_A', text: 'What is your biggest strength?', start: 8500, end: 11000 },
      { speaker: 'Speaker_B', text: 'I am very good at working with cross-functional teams.', start: 11500, end: 15000 },
    ],
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  // POST /auth/token
  if (method === 'POST' && url === '/auth/token') {
    await readBody(req);
    console.log('[mock] POST /auth/token — returning mock session');
    return json(res, 200, {
      token: 'mock-token-abc123',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      userId: 'test-user-1',
      displayName: 'Test User',
    });
  }

  // POST /upload-url
  if (method === 'POST' && url === '/upload-url') {
    await readBody(req);
    console.log('[mock] POST /upload-url — returning mock pre-signed URLs');
    return json(res, 200, {
      uploadUrl: 'http://localhost:3000/mock-s3/audio',
      transcriptUploadUrl: 'http://localhost:3000/mock-s3/transcript',
    });
  }

  // PUT /mock-s3/audio
  if (method === 'PUT' && url === '/mock-s3/audio') {
    const body = await readBody(req);
    console.log(`[mock] PUT /mock-s3/audio — received ${body.length} bytes`);
    return json(res, 200, { ok: true });
  }

  // PUT /mock-s3/transcript
  if (method === 'PUT' && url === '/mock-s3/transcript') {
    const body = await readBody(req);
    console.log('[mock] PUT /mock-s3/transcript — received transcript JSON:');
    try {
      console.log(JSON.stringify(JSON.parse(body.toString()), null, 2));
    } catch {
      console.log(body.toString());
    }
    return json(res, 200, { ok: true });
  }

  // GET /recordings/list
  if (method === 'GET' && url === '/recordings/list') {
    console.log('[mock] GET /recordings/list');
    return json(res, 200, RECORDINGS_LIST);
  }

  // GET /recordings/:id
  const getMatch = url.match(/^\/recordings\/([^/?]+)$/);
  if (method === 'GET' && getMatch) {
    const id = decodeURIComponent(getMatch[1]);
    console.log(`[mock] GET /recordings/${id}`);
    return json(res, 200, makeTranscript(id));
  }

  // PUT /recordings/:id
  if (method === 'PUT' && getMatch) {
    const id = decodeURIComponent(getMatch[1]);
    const body = await readBody(req);
    console.log(`[mock] PUT /recordings/${id}:`, body.toString());
    return json(res, 200, { success: true });
  }

  // 404
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Mock backend running at http://localhost:${PORT}`);
  console.log('Use http://localhost:3000 as the Backend API URL in the extension onboarding');
});
