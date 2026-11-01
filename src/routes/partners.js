// MoA partners: a student says who they are working with, and the link is shared both ways, so one MoA covers all of them
// (see groups.js). Anyone in the class can be picked from the list of registered students.
import { Router } from "express";
import { db } from "../db.js";
import { HttpError, requireAuth, requireRole } from "../auth.js";
import { parseId } from "../validate.js";

const router = Router();
router.use("/partners", requireAuth, requireRole("student", "admin")); // advisers are not part of the class; only /partners, this router is mounted on all of /api

const MAX_PARTNERS = 5;

// "Ana Reyes", or "Ana Reyes (ID …1234)" when two students share a name, so the right one can be picked.
function labelled(rows) {
  const count = new Map();
  for (const r of rows) count.set(r.full_name, (count.get(r.full_name) ?? 0) + 1);
  return rows.map((r) => {
    const name = r.full_name || "Unnamed student";
    const tail = String(r.student_id || "").slice(-4);
    return { id: Number(r.id), name: count.get(r.full_name) > 1 ? `${name} (ID …${tail || r.id})` : name };
  });
}

// Everyone the student could pick (names only: no emails or IDs are shared), and who they have picked already.
router.get("/partners", async (req, res) => {
  const { rows } = await db.execute({
    sql: `SELECT id, full_name, student_id FROM users
          WHERE role IN ('student', 'admin') AND id <> ? ORDER BY full_name, id`,
    args: [req.user.id],
  });
  const { rows: mine } = await db.execute({
    sql: "SELECT partner_id FROM partners WHERE user_id = ?",
    args: [req.user.id],
  });
  const chosen = new Set(mine.map((m) => Number(m.partner_id)));
  const everyone = labelled(rows);
  res.json({
    partners: everyone.filter((s) => chosen.has(s.id)),
    students: everyone,
  });
});

router.post("/partners", async (req, res) => {
  const partnerId = parseId(req.body?.partnerId);
  if (partnerId === req.user.id) throw new HttpError(400, "You cannot be your own partner.");
  const { rows: found } = await db.execute({
    sql: "SELECT id FROM users WHERE id = ? AND role IN ('student', 'admin')",
    args: [partnerId],
  });
  if (!found[0]) throw new HttpError(404, "That student was not found.");
  const { rows: count } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM partners WHERE user_id = ? AND partner_id <> ?",
    args: [req.user.id, partnerId],
  });
  if (Number(count[0].n) >= MAX_PARTNERS) throw new HttpError(400, `You can add up to ${MAX_PARTNERS} partners.`);
  // The link is stored in both directions, so it reads the same from either student.
  await db.batch(
    [
      { sql: "INSERT OR IGNORE INTO partners (user_id, partner_id) VALUES (?, ?)", args: [req.user.id, partnerId] },
      { sql: "INSERT OR IGNORE INTO partners (user_id, partner_id) VALUES (?, ?)", args: [partnerId, req.user.id] },
    ],
    "write",
  );
  res.status(201).json({ ok: true });
});

router.delete("/partners/:id", async (req, res) => {
  const partnerId = parseId(req.params.id);
  const [removed] = await db.batch(
    [
      { sql: "DELETE FROM partners WHERE user_id = ? AND partner_id = ?", args: [req.user.id, partnerId] },
      { sql: "DELETE FROM partners WHERE user_id = ? AND partner_id = ?", args: [partnerId, req.user.id] },
    ],
    "write",
  );
  if (!removed.rowsAffected) throw new HttpError(404, "You are not partnered with that student.");
  res.json({ ok: true });
});

export default router;
