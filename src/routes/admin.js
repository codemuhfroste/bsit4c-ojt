import { Router } from "express";
import { db } from "../db.js";
import { HttpError, ROLES, STAFF, endAllSessions, requireRole } from "../auth.js";
import { publicUser } from "../auth.js";
import { eraseUser } from "../accounts.js";
import { parseDate, parseId, parseText } from "../validate.js";
import { loadChecklist, shapeCompany } from "./checklist.js";

const router = Router();

function parseRequirement(body) {
  const sortOrder = Number(body?.sortOrder ?? 0);
  if (!Number.isInteger(sortOrder)) throw new HttpError(400, "Sort order must be a whole number.");
  return {
    title: parseText(body?.title, "Title", 200, { required: true }),
    description: parseText(body?.description, "Description", 1000),
    phase: parseText(body?.phase, "Phase", 60) || "General",
    dueDate: parseDate(body?.dueDate),
    requiresFile: body?.requiresFile === false ? 0 : 1,
    available: body?.available === false ? 0 : 1,
    optional: body?.optional === true ? 1 : 0,
    sortOrder,
  };
}

// ---- Requirements (admin) ----

router.post("/requirements", requireRole("admin"), async (req, res) => {
  const r = parseRequirement(req.body);
  const result = await db.execute({
    sql: "INSERT INTO requirements (title, description, phase, due_date, requires_file, available, optional, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [r.title, r.description, r.phase, r.dueDate, r.requiresFile, r.available, r.optional, r.sortOrder],
  });
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});

router.put("/requirements/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const r = parseRequirement(req.body);
  const result = await db.execute({
    sql: `UPDATE requirements
          SET title = ?, description = ?, phase = ?, due_date = ?, requires_file = ?, available = ?, optional = ?, sort_order = ? WHERE id = ?`,
    args: [r.title, r.description, r.phase, r.dueDate, r.requiresFile, r.available, r.optional, r.sortOrder, id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Requirement not found.");
  res.json({ ok: true });
});

router.delete("/requirements/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const { rows: found } = await db.execute({ sql: "SELECT kind FROM requirements WHERE id = ?", args: [id] });
  if (found[0]?.kind === "companies") {
    throw new HttpError(400, "The company list task cannot be deleted. Mark it N/A instead.");
  }
  const result = await db.batch(
    [
      { sql: "DELETE FROM submissions WHERE requirement_id = ?", args: [id] },
      { sql: "DELETE FROM requirements WHERE id = ?", args: [id] },
    ],
    "write",
  );
  if (!result[1].rowsAffected) throw new HttpError(404, "Requirement not found.");
  res.json({ ok: true });
});

// ---- Students and review (adviser + admin) ----

// The monitoring grid: one row per student, one cell per requirement, and the companies each student listed.
router.get("/tracker", requireRole(...STAFF), async (_req, res) => {
  const { rows: reqs } = await db.execute(
    "SELECT id, title, phase, kind, available, optional FROM requirements ORDER BY sort_order, id",
  );
  const { rows: students } = await db.execute(
    "SELECT id, full_name, student_id, email, email_verified_at, created_at FROM users WHERE role = 'student' ORDER BY full_name, email",
  );
  const { rows: subs } = await db.execute("SELECT id, user_id, requirement_id, status, updated_at FROM submissions");
  const { rows: comps } = await db.execute(
    "SELECT user_id, name, location, applied, response, moa, review, created_at FROM companies ORDER BY id",
  );

  const group = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = Number(row.user_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  };
  const subsBy = group(subs);
  const compBy = group(comps);

  res.json({
    requirements: reqs.map((r) => ({
      id: Number(r.id),
      title: r.title,
      phase: r.phase,
      kind: r.kind,
      available: Boolean(r.available),
      optional: Boolean(r.optional),
    })),
    students: students.map((u) => {
      const mine = subsBy.get(Number(u.id)) ?? [];
      const list = compBy.get(Number(u.id)) ?? [];
      const stamps = [u.created_at, ...list.map((c) => c.created_at), ...mine.map((x) => x.updated_at)].filter(Boolean);
      return {
        id: Number(u.id),
        fullName: u.full_name,
        studentId: u.student_id,
        email: u.email,
        emailVerified: Boolean(u.email_verified_at),
        cells: Object.fromEntries(mine.map((x) => [Number(x.requirement_id), { status: x.status, id: Number(x.id) }])),
        // The exact names, in the order the student added them (this is what the grid and its CSV show).
        companyList: list.map((c) => ({
          name: c.name,
          location: c.location,
          applied: Boolean(c.applied),
          response: c.response,
          moa: Boolean(c.moa),
          review: c.review,
        })),
        companies: {
          total: list.length,
          applied: list.filter((c) => c.applied).length,
          accepted: list.filter((c) => c.response === "accepted").length,
          approved: list.filter((c) => c.review === "approved").length,
          rejected: list.filter((c) => c.review === "rejected").length,
          moa: list.filter((c) => c.moa).length,
          inside: list.filter((c) => c.location === "inside").length,
        },
        lastActivity: stamps.sort().at(-1),
      };
    }),
  });
});

router.get("/users", requireRole(...STAFF), async (_req, res) => {
  const total = Number(
    (await db.execute("SELECT COUNT(*) AS n FROM requirements WHERE available = 1 AND optional = 0")).rows[0].n,
  );
  const { rows } = await db.execute(`
    SELECT u.id, u.email, u.role, u.full_name, u.student_id, u.email_verified_at,
           COUNT(s.id) AS submitted,
           COALESCE(SUM(s.status = 'approved'), 0) AS approved,
           COALESCE(SUM(s.status = 'submitted'), 0) AS in_review
    FROM users u
    LEFT JOIN (
      SELECT s.* FROM submissions s JOIN requirements r ON r.id = s.requirement_id
      WHERE r.available = 1 AND r.optional = 0
    ) s ON s.user_id = u.id
    GROUP BY u.id ORDER BY u.full_name, u.email`);
  res.json({
    totalRequirements: total,
    users: rows.map((u) => ({
      id: Number(u.id),
      email: u.email,
      role: u.role,
      fullName: u.full_name,
      studentId: u.student_id,
      emailVerified: Boolean(u.email_verified_at) || STAFF.includes(u.role),
      submitted: Number(u.submitted),
      approved: Number(u.approved),
      inReview: Number(u.in_review),
    })),
  });
});

router.get("/submissions", requireRole(...STAFF), async (req, res) => {
  const where = [];
  const args = [];
  if (req.query.status) {
    if (!["submitted", "approved", "rejected"].includes(req.query.status)) throw new HttpError(400, "Unknown status.");
    where.push("s.status = ?");
    args.push(req.query.status);
  }
  if (req.query.userId) {
    where.push("s.user_id = ?");
    args.push(parseId(req.query.userId));
  }
  const { rows } = await db.execute({
    sql: `SELECT s.id, s.status, s.note, s.file_name, s.updated_at, u.email, u.full_name, u.student_id,
                 s.user_id, r.title AS requirement, r.kind
          FROM submissions s
          JOIN users u ON u.id = s.user_id
          JOIN requirements r ON r.id = s.requirement_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY s.updated_at DESC LIMIT 200`,
    args,
  });
  // Company-list submissions show the student's companies instead of a file.
  const companyOwners = [...new Set(rows.filter((s) => s.kind === "companies").map((s) => Number(s.user_id)))];
  const byUser = new Map();
  if (companyOwners.length) {
    const { rows: list } = await db.execute({
      sql: `SELECT user_id, id, name, link, email, location, applied, response, moa, review, review_note FROM companies
            WHERE user_id IN (${companyOwners.map(() => "?").join(",")}) ORDER BY id`,
      args: companyOwners,
    });
    for (const c of list) {
      const key = Number(c.user_id);
      const entry = {
        id: Number(c.id),
        name: c.name,
        link: c.link,
        email: c.email,
        location: c.location,
        applied: Boolean(c.applied),
        response: c.response,
        moa: Boolean(c.moa),
        review: c.review,
        reviewNote: c.review_note,
      };
      byUser.set(key, [...(byUser.get(key) ?? []), entry]);
    }
  }
  res.json({
    submissions: rows.map((s) => ({
      id: Number(s.id),
      status: s.status,
      note: s.note,
      fileName: s.file_name,
      updatedAt: s.updated_at,
      email: s.email,
      fullName: s.full_name,
      studentId: s.student_id,
      requirement: s.requirement,
      kind: s.kind,
      userId: Number(s.user_id),
      companies: s.kind === "companies" ? (byUser.get(Number(s.user_id)) ?? []) : undefined,
    })),
  });
});

// One student's whole checklist, companies included, for the adviser's student page.
router.get("/users/:id", requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
  if (!rows[0]) throw new HttpError(404, "Student not found.");
  const { rows: companies } = await db.execute({
    sql: "SELECT * FROM companies WHERE user_id = ? ORDER BY id",
    args: [id],
  });
  res.json({ user: publicUser(rows[0]), ...(await loadChecklist(id)), companies: companies.map(shapeCompany) });
});

// ---- CSV exports for the coordinator (adviser + admin) ----

const BOM = "\uFEFF"; // lets Excel read UTF-8

// Quotes a cell, and neutralises leading = + - @ so a student-typed value cannot run as a spreadsheet formula.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendCsv(res, name, table) {
  const body = BOM + table.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  res.type("text/csv; charset=utf-8");
  res.attachment(`${name}-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(body);
}

const STATUS_LABEL = { approved: "Approved", submitted: "In review", rejected: "Needs changes" };

// Same layout as the Tracker grid, ready for Excel: one row per student, a status column for every open required
// requirement, then Company 1, Company 2, ... holding the exact company names. Optional tasks are left out.
router.get("/export/progress.csv", requireRole(...STAFF), async (_req, res) => {
  const { rows: reqs } = await db.execute(
    "SELECT id, title FROM requirements WHERE available = 1 AND optional = 0 ORDER BY sort_order, id",
  );
  const { rows: students } = await db.execute("SELECT * FROM users WHERE role = 'student' ORDER BY full_name, email");
  const { rows: subs } = await db.execute("SELECT user_id, requirement_id, status FROM submissions");
  const { rows: comps } = await db.execute("SELECT user_id, name FROM companies ORDER BY id");

  const status = new Map(subs.map((s) => [`${s.user_id}:${s.requirement_id}`, s.status]));
  const namesBy = new Map();
  for (const c of comps) {
    const key = Number(c.user_id);
    namesBy.set(key, [...(namesBy.get(key) ?? []), c.name]);
  }
  const slots = Math.max(1, ...students.map((u) => (namesBy.get(Number(u.id)) ?? []).length));

  const table = [
    [
      "Name",
      "Student ID",
      "Email",
      "Email verified",
      ...reqs.map((r) => r.title),
      "Required approved",
      ...Array.from({ length: slots }, (_, i) => `Company ${i + 1}`),
    ],
  ];
  for (const u of students) {
    const approved = reqs.filter((r) => status.get(`${u.id}:${r.id}`) === "approved").length;
    const names = namesBy.get(Number(u.id)) ?? [];
    table.push([
      u.full_name,
      u.student_id,
      u.email,
      u.email_verified_at ? "Yes" : "No",
      ...reqs.map((r) => STATUS_LABEL[status.get(`${u.id}:${r.id}`)] ?? "To do"),
      `${approved}/${reqs.length}`,
      ...Array.from({ length: slots }, (_, i) => names[i] ?? ""),
    ]);
  }
  sendCsv(res, "ojt-progress", table);
});

// One row per company a student listed.
router.get("/export/companies.csv", requireRole(...STAFF), async (_req, res) => {
  const { rows } = await db.execute(`
    SELECT u.full_name, u.student_id, u.email AS student_email, c.*
    FROM companies c JOIN users u ON u.id = c.user_id
    ORDER BY u.full_name, u.email, c.id`);
  const table = [
    [
      "Student",
      "Student ID",
      "Student email",
      "Company",
      "Facebook / website",
      "Company email",
      "Location",
      "Applied",
      "Response",
      "MoA with BU",
      "Review",
      "Review note",
      "Added",
    ],
    ...rows.map((c) => [
      c.full_name,
      c.student_id,
      c.student_email,
      c.name,
      c.link,
      c.email || "N/A",
      c.location === "inside" ? "Inside Legazpi" : "Outside Legazpi",
      c.applied ? "Yes" : "No",
      c.applied ? { none: "No response", accepted: "Accepted", denied: "Denied" }[c.response] : "",
      c.moa ? "Yes" : "No",
      { pending: "Not reviewed", approved: "Approved", rejected: "Rejected" }[c.review],
      c.review_note,
      c.created_at,
    ]),
  ];
  sendCsv(res, "ojt-companies", table);
});

// ---- Companies (adviser + admin) ----

// Approve or reject one company a student listed ("pending" clears an earlier decision).
router.post("/companies/:id/review", requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const status = req.body?.status;
  if (!["approved", "rejected", "pending"].includes(status)) {
    throw new HttpError(400, "Status must be approved, rejected or pending.");
  }
  const note = status === "pending" ? "" : parseText(req.body?.note, "Note", 300);
  if (status === "rejected" && !note) throw new HttpError(400, "Tell the student why it was rejected.");

  const result = await db.execute({
    sql: `UPDATE companies SET review = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`,
    args: [status, note, req.user.id, id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Company not found.");
  res.json({ ok: true });
});

// Staff-only: whether the university has a Memorandum of Agreement with this company.
router.patch("/companies/:id", requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  if (typeof req.body?.moa !== "boolean") throw new HttpError(400, "moa must be true or false.");
  const result = await db.execute({
    sql: "UPDATE companies SET moa = ? WHERE id = ?",
    args: [req.body.moa ? 1 : 0, id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Company not found.");
  res.json({ ok: true });
});

router.post("/submissions/:id/review", requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const status = req.body?.status;
  if (status !== "approved" && status !== "rejected") throw new HttpError(400, "Status must be approved or rejected.");
  const note = parseText(req.body?.note, "Note", 500);
  if (status === "rejected" && !note) throw new HttpError(400, "Tell the student why it was rejected.");

  const result = await db.execute({
    sql: `UPDATE submissions SET status = ?, note = ?, reviewer_id = ?, reviewed_at = datetime('now'),
          updated_at = datetime('now') WHERE id = ?`,
    args: [status, note, req.user.id, id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Submission not found.");
  res.json({ ok: true });
});

// ---- Roles (admin) ----

router.patch("/users/:id/role", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const role = req.body?.role;
  if (!ROLES.includes(role)) throw new HttpError(400, "Unknown role.");
  if (id === req.user.id) throw new HttpError(400, "You cannot change your own role.");
  const result = await db.execute({ sql: "UPDATE users SET role = ? WHERE id = ?", args: [role, id] });
  if (!result.rowsAffected) throw new HttpError(404, "User not found.");
  res.json({ ok: true });
});

// Erasure request handled by an admin (for example, a student who asks by email). Admin accounts are demoted first.
router.delete("/users/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, "Use Profile > Delete my account for your own account.");
  const { rows } = await db.execute({ sql: "SELECT role FROM users WHERE id = ?", args: [id] });
  if (!rows[0]) throw new HttpError(404, "User not found.");
  if (rows[0].role === "admin")
    throw new HttpError(409, "Change this admin to a student or adviser before deleting the account.");
  await eraseUser(id);
  res.json({ ok: true });
});

router.delete("/users/:id/sessions", requireRole("admin"), async (req, res) => {
  await endAllSessions(parseId(req.params.id));
  res.json({ ok: true });
});

export default router;
