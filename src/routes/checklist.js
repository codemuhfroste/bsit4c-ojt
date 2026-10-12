import { Router } from "express";
import { db } from "../db.js";
import { HttpError, STAFF, requireAuth, requireVerified } from "../auth.js";
import { hasExpectedSignature, upload } from "../uploads.js";
import { parseId } from "../validate.js";

const router = Router();
router.use(requireAuth);

const shapeRequirement = (r) => ({
  id: Number(r.id),
  title: r.title,
  description: r.description,
  phase: r.phase,
  sortOrder: Number(r.sort_order),
  dueDate: r.due_date,
  requiresFile: Boolean(r.requires_file),
  submission: r.sub_id
    ? {
        id: Number(r.sub_id),
        status: r.status,
        note: r.note,
        fileName: r.file_name,
        updatedAt: r.sub_updated_at,
      }
    : null,
});

router.get("/requirements", async (req, res) => {
  const { rows } = await db.execute({
    sql: `SELECT r.*, s.id AS sub_id, s.status, s.note, s.file_name, s.updated_at AS sub_updated_at
          FROM requirements r
          LEFT JOIN submissions s ON s.requirement_id = r.id AND s.user_id = ?
          ORDER BY r.sort_order, r.id`,
    args: [req.user.id],
  });
  const items = rows.map(shapeRequirement);
  const count = (status) => items.filter((i) => i.submission?.status === status).length;
  res.json({
    items,
    progress: { total: items.length, submitted: items.filter((i) => i.submission).length, approved: count("approved") },
  });
});

// Submitting needs a verified email. The file is optional only for requirements that do not require one.
router.post("/requirements/:id/submit", requireVerified, upload.single("file"), async (req, res) => {
  const file = req.file;
  const id = parseId(req.params.id);
  const { rows } = await db.execute({ sql: "SELECT * FROM requirements WHERE id = ?", args: [id] });
  const requirement = rows[0];
  if (!requirement) throw new HttpError(404, "Requirement not found.");
  if (requirement.requires_file && !file) throw new HttpError(400, "Attach a file for this requirement.");
  if (file && !hasExpectedSignature(file)) throw new HttpError(400, "That file does not match its type.");

  const existing = (
    await db.execute({
      sql: "SELECT status FROM submissions WHERE user_id = ? AND requirement_id = ?",
      args: [req.user.id, id],
    })
  ).rows[0];
  if (existing?.status === "approved") throw new HttpError(409, "This requirement is already approved.");

  // Without a new file, a re-submission keeps the previously uploaded one (COALESCE).
  await db.execute({
    sql: `INSERT INTO submissions (user_id, requirement_id, status, file_name, mime_type, size, file_data)
          VALUES (?1, ?2, 'submitted', ?3, ?4, ?5, ?6)
          ON CONFLICT (user_id, requirement_id) DO UPDATE SET
            status = 'submitted', note = '', reviewer_id = NULL, reviewed_at = NULL,
            file_name = COALESCE(?3, file_name),
            mime_type = COALESCE(?4, mime_type),
            size = COALESCE(?5, size),
            file_data = COALESCE(?6, file_data),
            updated_at = datetime('now')`,
    args: [
      req.user.id,
      id,
      file?.originalname.slice(0, 200) ?? null,
      file?.mimetype ?? null,
      file?.size ?? null,
      file?.buffer ?? null,
    ],
  });
  res.json({ ok: true });
});

router.delete("/requirements/:id/submission", requireVerified, async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.execute({
    sql: "SELECT id, status FROM submissions WHERE user_id = ? AND requirement_id = ?",
    args: [req.user.id, id],
  });
  if (!rows[0]) throw new HttpError(404, "Nothing submitted for this requirement.");
  if (rows[0].status === "approved") throw new HttpError(409, "An approved submission cannot be withdrawn.");
  await db.execute({ sql: "DELETE FROM submissions WHERE id = ?", args: [rows[0].id] });
  res.json({ ok: true });
});

// Owners and staff (advisers/admins) may download a submitted file.
router.get("/submissions/:id/file", async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.execute({
    sql: "SELECT user_id, file_name, mime_type, file_data FROM submissions WHERE id = ?",
    args: [id],
  });
  const sub = rows[0];
  if (!sub?.file_data || (Number(sub.user_id) !== req.user.id && !STAFF.includes(req.user.role))) {
    throw new HttpError(404, "File not found.");
  }
  res.type(sub.mime_type);
  res.attachment(sub.file_name || "submission");
  res.send(Buffer.from(sub.file_data));
});

export default router;
