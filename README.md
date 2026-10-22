# bsit4c-ojt

OJT requirements checklist for BSIT 4C. Students register and submit each OJT requirement
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

Set `ADMIN_EMAILS=you@school.edu` in `.env`, then register with that address and **verify it** with the emailed
link. It becomes an admin as soon as it is verified (an unverified address is never promoted, so nobody can claim
an admin address before its owner does). This is the only place email verification still matters: **nobody else has
to verify their email**, no verification email is sent for ordinary signups, and unverified accounts can submit
requirements like anyone else. Admins can then promote others to `adviser` or `admin` from the **Students** tab.

### Email

With `SMTP_URL` set (e.g. `smtps://user:pass@smtp.example.com`), the admin verification and password-reset emails are sent
for real. Without it they are printed to the server console, so in development copy the link from there.

## Current tasks

The coordinator's first two tasks are open; every other requirement is shown crossed out as **N/A for now**:

1. **Find OJT companies** – each student lists companies with their Facebook page or website (optional), the company email
   (or N/A), and whether they are inside or outside Legazpi. Each company also tracks **Applied / Not applied** and,
   once applied, the company's response: **No response / Accepted / Denied**. Double-click any of those tags (or
   focus one and press Enter) to flip it. There is no submit step and **no adviser review**: the task counts as done
   as soon as one company is added (and goes back to to-do if the list is emptied), and students can keep adding,
   editing or removing companies at any time. Advisers see the list on the student's page and in the Tracker.
2. **Resume / CV** – a PDF or image upload. It is **optional**: students can submit it, but it does not count toward
   their progress.

### The student roadmap

The top of a student's Checklist shows a four-step **OJT roadmap** with a "You are here" marker, so nobody has to guess
what to do next: (1) send the letter of intent and wait for a company to accept, (2) edit the MoA template and send it
to that company for review (not signing), (3) submit the reviewed MoA here, (4) prepare the other documents while the
block finishes its MoAs. The marker follows the student's data: step 1 is done once a company is marked **Accepted**,
step 3 once the "Memorandum of Agreement" task has a submission, and step 2 (which leaves no trace in the app) is ticked
by the student with **I sent it for review** (remembered in their browser only). A side panel lists the key dates and
reminders from the orientation. All of the wording lives in `public/roadmap.js`. Downloads sit with the section they
belong to: the MoA template (Word, so students can edit it, and PDF) is on roadmap step 2 and on the "Memorandum of
Agreement" task itself, and step 4 lists the other forms to accomplish once a company accepts the student (Letter of
Acceptance, Mentorship Plan, Training Agreement and Waiver, and the Endorsement Letter for companies that only accepted
a letter of request). They live in `public/files/`; in those Word files every value that belongs to a student, a company
or a date is blank and highlighted in yellow so students can see what to fill in. Replace a file there to update it.
Step 1 treats the letter of intent, request and inquiry as the same thing and notes that the department head's signatory
is optional. Tasks that are not open yet (N/A for now) are hidden from students.

Admins can open or close any requirement (**Mark N/A** / **Open it** on the Requirements tab) as the coordinator
releases the next tasks. Closed requirements cannot be submitted and are not counted in progress. The edit form also
has an **Optional** checkbox for tasks that should not count toward progress.

### How advisers check submissions

- **Students tab** – every student with a progress bar and how many submissions await action. Click a student to open
  their page: every requirement with its status, their files, their company list (links, emails, inside/outside,
  applied, response), and Approve / Reject with a note on each document right there.
- **Review tab** – the queue across all students. Filter by Needs review / Rejected / Approved / All, and search by
  student, ID or requirement. Click a student's name to jump to their page.
- **Tracker tab** – a full-screen grid for monitoring the whole class: one row per student (admins are listed too).
  Columns are the open required tasks (**Done**, **In review**, **Needs changes**, outlined red **Missing**), a single
  **Companies** column, and **Last activity**. The Companies cell shows a **green check** with how many companies the
  student has listed, or **Missing** if none yet. **Hover (or focus) the cell** to see the companies by name, with
  whether the student applied and the company's answer. The header and student column stay in view while you scroll,
  and a totals row is pinned at the bottom. Click a header to sort (most urgent first), filter by _Has missing work /
  Waiting for review / Complete_, search by student, ID, email **or company name**, and tick **Show N/A tasks** to
  include the closed requirements. **Export to Excel (CSV)** lists every company name in its own column (Name, Student
  ID, Email, task statuses, Required approved, Company 1…N). Arrow keys move between cells; Enter or double-click opens
  the student. It refreshes itself every minute.
- **Overview tab** (advisers) – class totals, the students who have no company yet, and how far the company hunt
  has got (accepted by a company, applied and waiting, listed, nothing listed).
- **MoA with BU** – advisers (not students) can flag a company as having a Memorandum of Agreement with the
  university by double-clicking its **MoA** tag. Students see the **MoA with BU** tag on that company.
- **Exports** – on the Students tab, **Progress CSV** (one row per student, a status column for each open
  requirement) and **Companies CSV** (one row per company) for the coordinator. Values that look like spreadsheet
  formulas are neutralised.

## Roles

| Role      | Can do                                                                          |
| --------- | ------------------------------------------------------------------------------- |
| `student` | See the checklist, submit/withdraw requirements, edit own profile and password. |
| `adviser` | Everything a student can, plus review submissions and view all students.        |
| `admin`   | Everything an adviser can, plus manage requirements and change user roles.      |

Approved submissions are locked; rejected ones show the reviewer's note and can
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
| `POST /verify`                | `{ token }` from the emailed link (only `ADMIN_EMAILS` addresses)  |
| `POST /verify/resend`         | Logged-in users                                                    |
| `POST /password/forgot`       | `{ email }`; always 200                                            |
| `POST /password/reset`        | `{ token, password }`; signs out all devices                       |

**Checklist**

| Endpoint                                                 | Notes                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /requirements`                                      | Requirements with your submission status, plus progress                                                                                                                               |
| `POST /requirements/:id/submit`                          | `multipart/form-data`, optional `file` (PDF/PNG/JPEG, 4 MB)                                                                                                                           |
| `DELETE /requirements/:id/submission`                    | Withdraw (not allowed once approved)                                                                                                                                                  |
| `GET /submissions/:id/file`                              | Owner or staff                                                                                                                                                                        |
| `GET/POST /companies`, `PUT/PATCH/DELETE /companies/:id` | Your own company list: `name`, `link`, `email` (or `N/A`), `location` (`inside`/`outside`), `applied`, `response` (`none`/`accepted`/`denied`). `PATCH` changes just those last three |

**Staff** (`/api/admin`)

| Endpoint                                                | Role    |
| ------------------------------------------------------- | ------- |
| `GET /users`, `GET /submissions?status=&userId=`        | adviser |
| `POST /submissions/:id/review` `{ status, note }`       | adviser |
| `POST /requirements`, `PUT/DELETE /requirements/:id`    | admin   |
| `PATCH /users/:id/role` `{ role }`                      | admin   |
| `DELETE /users/:id/sessions`                            | admin   |
| `GET /users/:id` (a student's checklist + companies)    | adviser |
| `GET /export/progress.csv`, `GET /export/companies.csv` | adviser |

## Privacy (Data Privacy Act of 2012)

- **Privacy Notice** at `/privacy.html`: what is collected and why, who can see it, the service providers and the
  cross-border storage (Vercel and Turso in the US, Gmail for email), retention, security, the data-subject rights and
  the National Privacy Commission. The contact address shown comes from `PRIVACY_CONTACT` (default: the `MAIL_FROM`
  address). The version lives in `src/privacy.js` (`PRIVACY_VERSION`); change it whenever the notice changes in a way
  that needs fresh consent, and everyone is asked to accept it again.
- **Consent** is required to create an account (a checkbox, enforced on the server) and is recorded with the time and
  version. People who signed up before the notice existed, or when the version changes, see a prompt they cannot dismiss
  until they accept (or log out, or delete their account).
- **Access / portability:** _Profile → Privacy & data → Download my data_ (`GET /api/me/export`, JSON, never includes
  the password).
- **Erasure:** _Delete my account_ (`DELETE /api/me`, needs the password) removes the account, company list, uploads,
  sessions and review records. Admins can erase a student on request from the student's page
  (`DELETE /api/admin/users/:id`). The only admin cannot delete their own account.
- **No third parties:** fonts are self-hosted and the content security policy allows only this site, so no visitor's
  address is sent to a font, analytics or ad provider. A test fails if a page ever loads something from another host.
- **Retention promise** in the notice: data is deleted or anonymized within 30 days after the class's OJT program ends.
  Adjust the wording in `public/privacy.html` if your school's policy differs, and have the university's Data
  Protection Officer review the notice before relying on it.

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
  nobody can reset a password (or verify an `ADMIN_EMAILS` address).
- **Rate limits** are counted per function instance (in memory), so they slow down guessing but are not a hard
  global cap. Put Vercel's firewall rate limiting in front if you need one.
- `NODE_ENV=production` and the proxy setting are applied automatically on Vercel.

### Docker

A `Dockerfile` is also included for self-hosting (`docker build -t bsit4c-ojt .`, then
`docker run -p 3000:3000 --env-file .env bsit4c-ojt`). Use the same variables; `GET /healthz` is the health check.
