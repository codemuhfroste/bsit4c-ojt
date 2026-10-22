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

  // 8: first coordinator tasks. Requirements can be closed ("N/A for now") and can be a company list instead of a file.
  [
    "ALTER TABLE requirements ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload'",
    "ALTER TABLE requirements ADD COLUMN available INTEGER NOT NULL DEFAULT 1",
    `CREATE TABLE companies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      link       TEXT NOT NULL,
      location   TEXT NOT NULL CHECK (location IN ('inside', 'outside')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX companies_user_idx ON companies (user_id)",
    {
      sql: `INSERT INTO requirements (title, description, phase, requires_file, sort_order, kind)
            VALUES (?, ?, 'Current tasks', 0, -1, 'companies')`,
      args: [
        "Find OJT companies",
        "List companies you could do your OJT with. Add their Facebook page or website and whether they are inside or outside Legazpi.",
      ],
    },
    "UPDATE requirements SET phase = 'Current tasks', sort_order = 0, description = 'Upload your updated resume (PDF, PNG or JPG).' WHERE title = 'Resume / CV'",
    ...[
      "Parent/guardian consent form",
      "Medical certificate",
      "Endorsement letter",
      "Memorandum of Agreement (MOA)",
      "Weekly accomplishment reports",
      "Daily time record (DTR)",
      "Certificate of completion",
    ].map((title) => ({ sql: "UPDATE requirements SET available = 0 WHERE title = ?", args: [title] })),
  ],

  // 9: company contact email, applied flag and the company's response ("" means N/A) and whether the student already applied there
  [
    "ALTER TABLE companies ADD COLUMN email TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN applied INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE companies ADD COLUMN response TEXT NOT NULL DEFAULT 'none' CHECK (response IN ('none', 'accepted', 'denied'))",
    {
      sql: "UPDATE requirements SET description = ? WHERE kind = 'companies'",
      args: [
        "List companies you could do your OJT with: their Facebook page or website, their email (N/A if none), whether they are inside or outside Legazpi, and whether you already applied, and whether they accepted, denied or have not replied.",
      ],
    },
  ],

  // 10: optional requirements do not count toward progress (the resume is optional for now)
  [
    "ALTER TABLE requirements ADD COLUMN optional INTEGER NOT NULL DEFAULT 0",
    "UPDATE requirements SET optional = 1, description = 'Optional: upload your updated resume (PDF, PNG or JPG).' WHERE title = 'Resume / CV'",
  ],

  // 11: advisers review each company, and flag companies that have a MoA with the university
  [
    "ALTER TABLE companies ADD COLUMN review TEXT NOT NULL DEFAULT 'pending' CHECK (review IN ('pending', 'approved', 'rejected'))",
    "ALTER TABLE companies ADD COLUMN review_note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN reviewed_by INTEGER",
    "ALTER TABLE companies ADD COLUMN reviewed_at TEXT",
    "ALTER TABLE companies ADD COLUMN moa INTEGER NOT NULL DEFAULT 0",
  ],

  // 12: record that each person accepted the Privacy Notice (and which version)
  ["ALTER TABLE users ADD COLUMN privacy_accepted_at TEXT", "ALTER TABLE users ADD COLUMN privacy_version TEXT"],

  // 13: no adviser reviews the company list any more, so the "Find OJT companies" task counts as done as soon as a
  // student has listed a company. Students who were waiting on a review are marked done too.
  [
    `UPDATE submissions SET status = 'approved', note = '', updated_at = datetime('now')
     WHERE status <> 'approved' AND requirement_id IN (SELECT id FROM requirements WHERE kind = 'companies')`,
  ],

  // 14: a student accepted by more than one company picks the final one, and the forms to accomplish once a company
  // accepts you join "Before OJT" in checklist order (the MoA first). Closed tasks stay closed.
  [
    "ALTER TABLE companies ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0",
    ...[
      [
        "Letter of Acceptance",
        "Download the template, fill in the yellow parts with your company, get it signed by your supervisor and your OJT coordinator, then upload it here.",
      ],
      [
        "Mentorship Plan",
        "Your mentor fills in the goals and the weekly tasks. Download the template and upload the signed plan here.",
        0,
      ],
      [
        "Training Agreement and Waiver",
        "Download the template and fill it in. It is signed by you, your parent or guardian and the Dean. Upload the signed copy here.",
      ],
    ].map(([title, description]) => ({
      sql: `INSERT INTO requirements (title, description, phase, requires_file, available, optional, sort_order)
            VALUES (?, ?, 'Before OJT', 1, 1, 0, 0)`,
      args: [title, description],
    })),
    "UPDATE requirements SET available = 1 WHERE title = 'Memorandum of Agreement (MOA)'",
    {
      sql: "UPDATE requirements SET available = 1, optional = 1, description = ? WHERE title = 'Endorsement letter'",
      args: [
        "Optional. Only needed if the company accepted you with just your letter of request, or asks for one before you apply. Download the template, fill it in, get it signed and upload it here.",
      ],
    },
    ...[
      ["Memorandum of Agreement (MOA)", 1],
      ["Letter of Acceptance", 2],
      ["Mentorship Plan", 3],
      ["Training Agreement and Waiver", 4],
      ["Endorsement letter", 5],
      ["Parent/guardian consent form", 6],
      ["Medical certificate", 7],
      ["Weekly accomplishment reports", 8],
      ["Daily time record (DTR)", 9],
      ["Certificate of completion", 10],
    ].map(([title, order]) => ({
      sql: "UPDATE requirements SET sort_order = ? WHERE title = ?",
      args: [order, title],
    })),
  ],
];
