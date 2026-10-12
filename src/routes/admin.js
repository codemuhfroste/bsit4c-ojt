import { Router } from "express";
import { db } from "../db.js";
import { HttpError, ROLES, STAFF, endAllSessions, requireRole } from "../auth.js";
import { parseDate, parseId, parseText } from "../validate.js";

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
    sortOrder,
  };
}

// ---- Requirements (admin) ----

router.post("/requirements", requireRole("admin"), async (req, res) => {
  const r = parseRequirement(req.body);
  const result = await db.execute({
    sql: "INSERT INTO requirements (title, description, phase, due_date, requires_file, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [r.title, r.description, r.phase, r.dueDate, r.requiresFile, r.sortOrder],
  });
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});

router.put("/requirements/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const r = parseRequirement(req.body);
  const result = await db.execute({
    sql: `UPDATE requirements
          SET title = ?, description = ?, phase = ?, due_date = ?, requires_file = ?, sort_order = ? WHERE id = ?`,
    args: [r.title, r.description, r.phase, r.dueDate, r.requiresFile, r.sortOrder, id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Requirement not found.");
  res.json({ ok: true });
});

router.delete("/requirements/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
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

router.get("/users", requireRole(...STAFF), async (_req, res) => {
  const total = Number((await db.execute("SELECT COUNT(*) AS n FROM requirements")).rows[0].n);
  const { rows } = await db.execute(`
    SELECT u.id, u.email, u.role, u.full_name, u.student_id, u.email_verified_at,
           COUNT(s.id) AS submitted,
           COALESCE(SUM(s.status = 'approved'), 0) AS approved
    FROM users u LEFT JOIN submissions s ON s.user_id = u.id
    GROUP BY u.id ORDER BY u.full_name, u.email`);
  res.json({
    totalRequirements: total,
    users: rows.map((u) => ({
      id: Number(u.id),
      email: u.email,
      role: u.role,
      fullName: u.full_name,
      studentId: u.student_id,
      emailVerified: Boolean(u.email_verified_at),
      submitted: Number(u.submitted),
      approved: Number(u.approved),
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
                 r.title AS requirement
          FROM submissions s
          JOIN users u ON u.id = s.user_id
          JOIN requirements r ON r.id = s.requirement_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY s.updated_at DESC LIMIT 200`,
    args,
  });
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
    })),
  });
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

router.delete("/users/:id/sessions", requireRole("admin"), async (req, res) => {
  await endAllSessions(parseId(req.params.id));
  res.json({ ok: true });
});

export default router;
