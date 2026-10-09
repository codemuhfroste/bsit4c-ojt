# bsit4c-ojt

OJT requirements checklist for BSIT 4C. Current scope: members register with an email and password.

## Setup

```
npm install
cp .env.example .env   # optional for local dev; see below
npm run dev
```

Open http://localhost:3000.

- Without `TURSO_DATABASE_URL`, accounts are stored in a local `local.db` SQLite file.
- For the shared Turso database, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`
  (see `.env.example` for the CLI commands).

## API

`POST /api/register` with JSON `{ "email", "password" }`

| Status | Meaning |
| --- | --- |
| 201 | Registered |
| 400 | Invalid email or password (8-72 bytes) |
| 409 | Email already registered |

Passwords are hashed with bcrypt; emails are stored lowercased and must be unique.
