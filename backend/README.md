# MeetRecord Backend

Lightweight Express API for the MeetRecord Chrome extension and web dashboard. Handles authentication, pre-signed S3 URLs for uploads, and transcript CRUD.

## Quick Start

```bash
cd backend
npm install
cp .env.example .env   # then edit .env with your values
npm start
```

Server starts on `http://localhost:3000` (or the PORT in `.env`).

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `AWS_REGION` | S3 bucket region |
| `AWS_ACCESS_KEY_ID` | IAM access key with S3 read/write |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `S3_BUCKET` | S3 bucket name for recordings and transcripts |
| `AUTH_MODE` | `simple` (default) or `keycloak` |
| `AUTH_TOKEN_SECRET` | Secret for signing JWTs in simple mode |
| `ADMIN_USERNAME` | Login username for simple mode |
| `ADMIN_PASSWORD` | Login password for simple mode |
| `ADMIN_DISPLAY_NAME` | Display name for simple mode user |

### Keycloak-only variables

| Variable | Description |
|---|---|
| `KEYCLOAK_URL` | Keycloak base URL (e.g. `https://keycloak.example.com`) |
| `KEYCLOAK_REALM` | Realm name |
| `KEYCLOAK_CLIENT_ID` | Client ID |
| `KEYCLOAK_CLIENT_SECRET` | Client secret |

## Auth Modes

### Simple (default)

Single-user mode using env-var credentials. The server signs JWTs with `AUTH_TOKEN_SECRET`. Good for development and small teams.

### Keycloak

Multi-user mode. The server exchanges credentials with Keycloak's token endpoint and returns the Keycloak-issued access token. Set `AUTH_MODE=keycloak` and fill in the Keycloak variables.

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/token` | No | Exchange username/password for a token |
| POST | `/upload-url` | Bearer | Get pre-signed S3 PUT URLs for audio + transcript |
| GET | `/recordings/list` | Bearer | List all uploaded recordings |
| GET | `/recordings/:id` | Bearer | Get a single transcript |
| PUT | `/recordings/:id` | Bearer | Update speaker labels or recording label |

## AWS Setup

1. Create an S3 bucket (e.g. `meetrecord-recordings`)
2. Create an IAM user with this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::meetrecord-recordings",
        "arn:aws:s3:::meetrecord-recordings/*"
      ]
    }
  ]
}
```

3. Add the access key and secret to `.env`

## S3 Object Layout

```
meetrecord-recordings/
├── recordings/
│   └── {recordingId}/
│       └── audio.webm
└── transcripts/
    └── {recordingId}.json
```

## Deploy to Railway

1. Push `backend/` to a Git repo (or use Railway's CLI)
2. Create a new Railway project and link the repo
3. Set the root directory to `backend`
4. Add all environment variables from `.env.example`
5. Railway auto-detects `npm start` — the server will start on the assigned port
