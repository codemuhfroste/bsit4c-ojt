// Append-only: never edit an applied migration, add a new entry instead.
// Each entry is a list of statements run atomically; its version is its index + 1.

const DEFAULT_REQUIREMENTS = [
  ["Parent/guardian consent form", "Signed consent for off-campus training.", 1],
  ["Medical certificate", "Fit-to-work certificate from a licensed physician.", 2],
  ["Endorsement letter", "Letter issued by the department endorsing you to the host company.", 3],
  ["Memorandum of Agreement (MOA)", "Signed agreement between the school and the host company.", 4],
  ["Resume / CV", "Updated resume submitted to the host company.", 5],
  ["Weekly accomplishment reports", "Scanned or PDF copy of your signed weekly reports.", 6],
  ["Daily time record (DTR)", "Final signed DTR showing the completed required hours.", 7],
  ["Certificate of completion", "Issued by the host company after you finish your hours.", 8],
];

export const migrations = [
  // 1: original registration table
  [
    `CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ],

  // 2: roles, profile fields, email verification
  [
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'",
    "ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN student_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN section TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN email_verified_at TEXT",
  ],

  // 3: login sessions (token stored hashed)
  [
    `CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX sessions_user_idx ON sessions (user_id)",
  ],

  // 4: one-time tokens for email verification and password reset (stored hashed)
  [
    `CREATE TABLE user_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      expires_at TEXT NOT NULL,
      used_at    TEXT
    )`,
  ],

  // 5: checklist requirements and per-student submissions
  [
    `CREATE TABLE requirements (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      due_date      TEXT,
      requires_file INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE submissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      requirement_id INTEGER NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
      note           TEXT NOT NULL DEFAULT '',
      file_name      TEXT,
      stored_name    TEXT,
      mime_type      TEXT,
      size           INTEGER,
      reviewer_id    INTEGER,
      reviewed_at    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, requirement_id)
    )`,
    "CREATE INDEX submissions_status_idx ON submissions (status)",
    ...DEFAULT_REQUIREMENTS.map(([title, description, sort]) => ({
      sql: "INSERT INTO requirements (title, description, sort_order) VALUES (?, ?, ?)",
      args: [title, description, sort],
    })),
  ],

  // 6: uploaded files live in the database (serverless hosts have no persistent disk)
  ["ALTER TABLE submissions ADD COLUMN file_data BLOB"],

  // 7: group requirements into phases (Before / During / After OJT)
  [
    "ALTER TABLE requirements ADD COLUMN phase TEXT NOT NULL DEFAULT 'General'",
    ...[
      [
        "Before OJT",
        [
          "Parent/guardian consent form",
          "Medical certificate",
          "Endorsement letter",
          "Memorandum of Agreement (MOA)",
          "Resume / CV",
        ],
      ],
      ["During OJT", ["Weekly accomplishment reports"]],
      ["After OJT", ["Daily time record (DTR)", "Certificate of completion"]],
    ].flatMap(([phase, titles]) =>
      titles.map((title) => ({ sql: "UPDATE requirements SET phase = ? WHERE title = ?", args: [phase, title] })),
    ),
  ],
];
