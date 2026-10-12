# bsit4c-ojt

OJT requirements checklist for BSIT 4C. Students register, verify their email, and submit each OJT requirement
(optionally with a PDF/PNG/JPEG upload). Advisers and admins review submissions and track class progress.

## Setup

```
npm install
cp .env.example .env   # optional for local dev; see below
npm run dev
```

Open http://localhost:3000.

- Without `TURSO_DATABASE_URL`, data is stored in a local `local.db` SQLite file.
- For the shared Turso database, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`
  (see `.env.example` for the CLI commands).
- Schema migrations (`src/migrations.js`) run automatically on startup. The first run also seeds a default list of
  requirements, which admins can edit.

### First admin

Set `ADMIN_EMAILS=you@school.edu` in `.env`, then register (or log in) with that address. It is made an admin
automatically. Admins can then promote others to `adviser` or `admin` from the **Students** tab.

### Email

With `SMTP_URL` set (e.g. `smtps://user:pass@smtp.example.com`), verification and password-reset emails are sent for
real. Without it they are printed to the server console, so in development copy the link from there.

## Roles

| Role      | Can do                                                                          |
| --------- | ------------------------------------------------------------------------------- |
| `student` | See the checklist, submit/withdraw requirements, edit own profile and password. |
| `adviser` | Everything a student can, plus review submissions and view all students.        |
| `admin`   | Everything an adviser can, plus manage requirements and change user roles.      |

Submitting requires a verified email. Approved submissions are locked; rejected ones show the reviewer's note and can
be re-submitted.

## API

All endpoints are JSON under `/api`. Sessions use an HttpOnly `sid` cookie. Errors look like `{ "error": "message" }`.

**Account**

| Endpoint                      | Notes                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `POST /register`              | `email`, `password` (8-72 bytes), optional `fullName`, `studentId` |
| `POST /login`, `POST /logout` |                                                                    |
| `GET /me`, `PATCH /me`        | Read / update profile fields                                       |
| `POST /me/password`           | `currentPassword`, `newPassword`; signs out other devices          |
| `POST /verify`                | `{ token }` from the emailed link                                  |
| `POST /verify/resend`         | Logged-in users                                                    |
| `POST /password/forgot`       | `{ email }`; always 200                                            |
| `POST /password/reset`        | `{ token, password }`; signs out all devices                       |

**Checklist**

| Endpoint                              | Notes                                                       |
| ------------------------------------- | ----------------------------------------------------------- |
| `GET /requirements`                   | Requirements with your submission status, plus progress     |
| `POST /requirements/:id/submit`       | `multipart/form-data`, optional `file` (PDF/PNG/JPEG, 4 MB) |
| `DELETE /requirements/:id/submission` | Withdraw (not allowed once approved)                        |
| `GET /submissions/:id/file`           | Owner or staff                                              |

**Staff** (`/api/admin`)

| Endpoint                                             | Role    |
| ---------------------------------------------------- | ------- |
| `GET /users`, `GET /submissions?status=&userId=`     | adviser |
| `POST /submissions/:id/review` `{ status, note }`    | adviser |
| `POST /requirements`, `PUT/DELETE /requirements/:id` | admin   |
| `PATCH /users/:id/role` `{ role }`                   | admin   |
| `DELETE /users/:id/sessions`                         | admin   |

## Security notes

- Passwords: bcrypt (cost 12). Sessions, verification and reset tokens are stored only as SHA-256 hashes.
- Login, register and reset endpoints are rate limited. Set `TRUST_PROXY=1` behind a reverse proxy.
- `helmet` security headers (including a strict CSP), same-origin check on writes, and `SameSite=Lax` cookies
  (`Secure` when `NODE_ENV=production`).
- Uploads are limited to PDF/PNG/JPEG by declared type and file signature, stored in the database, and only served to
  the owner or staff as downloads.

## Development

```
npm test            # API tests (node:test, temporary SQLite database)
npm run lint
npm run format      # prettier; `format:check` is what CI runs
```

CI (`.github/workflows/ci.yml`) runs lint, format check and tests on every push and pull request.

## Deployment (Vercel + Turso)

The app runs on Vercel as a single serverless function (`api/index.js`) with static files from `public/`. Data,
sessions and uploaded files all live in Turso, so nothing depends on the function's disk.

1. **Create the database**

   ```
   turso db create bsit4c-ojt
   turso db show bsit4c-ojt --url        # -> TURSO_DATABASE_URL
   turso db tokens create bsit4c-ojt     # -> TURSO_AUTH_TOKEN
   ```

   Tables are created automatically on the first request after each deploy (`src/migrations.js`).

2. **Import the repo** in Vercel (Framework preset: **Other**, no build command) and add these environment
   variables for Production (and Preview if you use it):

   | Variable                                 | Value                                                             |
   | ---------------------------------------- | ----------------------------------------------------------------- |
   | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | from step 1                                                       |
   | `APP_URL`                                | your site URL, e.g. `https://bsit4c-ojt.vercel.app` (email links) |
   | `ADMIN_EMAILS`                           | your email, to become the first admin                             |
   | `SMTP_URL`, `MAIL_FROM`                  | any SMTP provider, e.g. `smtps://user:pass@smtp.example.com`      |

   Or from the CLI: `npm i -g vercel && vercel link && vercel env add TURSO_DATABASE_URL production && vercel --prod`.

3. Register with the `ADMIN_EMAILS` address and you are the admin.

Things to know on Vercel:

- **Uploads** are stored in Turso and limited to 4 MB, because Vercel rejects request bodies over 4.5 MB.
- **SMTP is required.** In production, verification and reset links are never logged, so without `SMTP_URL`
  nobody can verify their email or reset a password.
- **Rate limits** are counted per function instance (in memory), so they slow down guessing but are not a hard
  global cap. Put Vercel's firewall rate limiting in front if you need one.
- `NODE_ENV=production` and the proxy setting are applied automatically on Vercel.

### Docker

A `Dockerfile` is also included for self-hosting (`docker build -t bsit4c-ojt .`, then
`docker run -p 3000:3000 --env-file .env bsit4c-ojt`). Use the same variables; `GET /healthz` is the health check.
