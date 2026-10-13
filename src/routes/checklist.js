import { Router } from "express";
import { db } from "../db.js";
import { HttpError, STAFF, requireAuth } from "../auth.js";
import { hasExpectedSignature, upload } from "../uploads.js";
import { parseEmail, parseId, parseLink, parseText } from "../validate.js";

const router = Router();
router.use(requireAuth);

export const shapeRequirement = (r) => ({
  id: Number(r.id),
  title: r.title,
  description: r.description,
  phase: r.phase,
  sortOrder: Number(r.sort_order),
  dueDate: r.due_date,
  requiresFile: Boolean(r.requires_file),
  kind: r.kind,
  available: Boolean(r.available),
  optional: Boolean(r.optional),
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

// A student's checklist. Progress counts only requirements that are open and not optional.
export async function loadChecklist(userId) {
  const { rows } = await db.execute({
    sql: `SELECT r.*, s.id AS sub_id, s.status, s.note, s.file_name, s.updated_at AS sub_updated_at
          FROM requirements r
          LEFT JOIN submissions s ON s.requirement_id = r.id AND s.user_id = ?
          ORDER BY r.sort_order, r.id`,
    args: [userId],
  });
  const items = rows.map(shapeRequirement);
  const counted = items.filter((i) => i.available && !i.optional);
  return {
    items,
    progress: {
      total: counted.length,
      submitted: counted.filter((i) => i.submission).length,
      approved: counted.filter((i) => i.submission?.status === "approved").length,
    },
  };
}

router.get("/requirements", async (req, res) => {
  res.json(await loadChecklist(req.user.id));
});

// The file is optional only for requirements that do not require one.
router.post("/requirements/:id/submit", upload.single("file"), async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.execute({ sql: "SELECT * FROM requirements WHERE id = ?", args: [id] });
  const requirement = rows[0];
  if (!requirement) throw new HttpError(404, "Requirement not found.");
  if (!requirement.available) throw new HttpError(409, "This requirement is not open yet.");
  if (requirement.kind === "companies") {
    throw new HttpError(400, "Your company list is submitted automatically when you add a company.");
  }
  const file = req.file;
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

router.delete("/requirements/:id/submission", async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.execute({
    sql: `SELECT s.id, s.status, r.kind FROM submissions s JOIN requirements r ON r.id = s.requirement_id
          WHERE s.user_id = ? AND s.requirement_id = ?`,
    args: [req.user.id, id],
  });
  if (!rows[0]) throw new HttpError(404, "Nothing submitted for this requirement.");
  if (rows[0].kind === "companies") throw new HttpError(400, "Remove the companies from your list instead.");
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

// ---- Companies (the "Find OJT companies" task) ----

const MAX_COMPANIES = 20;

export const shapeCompany = (c) => ({
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
  createdAt: c.created_at,
});

// The company's contact email is required, but "N/A" is accepted when it has none (stored as "").
function parseCompanyEmail(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, "Add the company's email, or enter N/A if it has none.");
  return /^n\/?a$/i.test(text) ? "" : parseEmail(text);
}

const RESPONSES = ["none", "accepted", "denied"];

// A response only makes sense once the student has applied, so it resets to "none" otherwise.
function parseResponse(value, applied) {
  const response = value ?? "none";
  if (!RESPONSES.includes(response)) throw new HttpError(400, "Response must be none, accepted or denied.");
  return applied ? response : "none";
}

function parseCompany(body) {
  const location = body?.location;
  if (location !== "inside" && location !== "outside") throw new HttpError(400, "Choose inside or outside Legazpi.");
  const applied = body?.applied === true ? 1 : 0;
  return {
    name: parseText(body?.name, "Company name", 150, { required: true }),
    link: parseLink(body?.link),
    email: parseCompanyEmail(body?.email),
    location,
    applied,
    response: parseResponse(body?.response, applied),
  };
}

// The "Find OJT companies" submission follows the list automatically: it counts as submitted as soon as the student
// has at least one company, and goes back to "to do" when the list is emptied. Approved stays approved while
// companies remain, and students can keep adding companies afterwards.
async function syncCompanySubmission(userId) {
  const { rows: found } = await db.execute("SELECT id FROM requirements WHERE kind = 'companies' ORDER BY id LIMIT 1");
  if (!found[0]) return;
  const requirementId = Number(found[0].id);
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM companies WHERE user_id = ?", args: [userId] });

  if (Number(rows[0].n) > 0) {
    await db.execute({
      sql: `INSERT INTO submissions (user_id, requirement_id, status) VALUES (?1, ?2, 'submitted')
            ON CONFLICT (user_id, requirement_id) DO UPDATE SET
              status = CASE WHEN status = 'approved' THEN 'approved' ELSE 'submitted' END,
              note = CASE WHEN status = 'approved' THEN note ELSE '' END,
              updated_at = datetime('now')`,
      args: [userId, requirementId],
    });
  } else {
    await db.execute({
      sql: "DELETE FROM submissions WHERE user_id = ? AND requirement_id = ?",
      args: [userId, requirementId],
    });
  }
}

router.get("/companies", async (req, res) => {
  const { rows } = await db.execute({
    sql: "SELECT * FROM companies WHERE user_id = ? ORDER BY id",
    args: [req.user.id],
  });
  res.json({ companies: rows.map(shapeCompany) });
});

router.post("/companies", async (req, res) => {
  const c = parseCompany(req.body);
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM companies WHERE user_id = ?",
    args: [req.user.id],
  });
  if (Number(rows[0].n) >= MAX_COMPANIES) throw new HttpError(400, `You can list up to ${MAX_COMPANIES} companies.`);
  const result = await db.execute({
    sql: "INSERT INTO companies (user_id, name, link, email, location, applied, response) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [req.user.id, c.name, c.link, c.email, c.location, c.applied, c.response],
  });
  await syncCompanySubmission(req.user.id);
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});

router.put("/companies/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const c = parseCompany(req.body);
  const result = await db.execute({
    // Changing the company itself (name, link or email) sends it back to "not reviewed"; ticking applied etc. does not.
    sql: `UPDATE companies SET
            review = CASE WHEN name = ?1 AND link = ?2 AND email = ?3 THEN review ELSE 'pending' END,
            review_note = CASE WHEN name = ?1 AND link = ?2 AND email = ?3 THEN review_note ELSE '' END,
            name = ?1, link = ?2, email = ?3, location = ?4, applied = ?5, response = ?6
          WHERE id = ?7 AND user_id = ?8`,
    args: [c.name, c.link, c.email, c.location, c.applied, c.response, id, req.user.id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Company not found.");
  await syncCompanySubmission(req.user.id);
  res.json({ ok: true });
});

// Quick one-field changes (the double-click toggles): location, applied and response only.
router.patch("/companies/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const { location, applied, response } = req.body ?? {};
  if (location !== undefined && location !== "inside" && location !== "outside") {
    throw new HttpError(400, "Choose inside or outside Legazpi.");
  }
  if (response !== undefined && !RESPONSES.includes(response)) {
    throw new HttpError(400, "Response must be none, accepted or denied.");
  }
  if (applied !== undefined && typeof applied !== "boolean") throw new HttpError(400, "Applied must be true or false.");

  // One statement: omitted fields keep their value, and a response only sticks while applied.
  const result = await db.execute({
    sql: `UPDATE companies SET
            location = COALESCE(?1, location),
            applied = COALESCE(?2, applied),
            response = CASE WHEN COALESCE(?2, applied) = 0 THEN 'none' ELSE COALESCE(?3, response) END
          WHERE id = ?4 AND user_id = ?5`,
    args: [location ?? null, applied === undefined ? null : applied ? 1 : 0, response ?? null, id, req.user.id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Company not found.");
  res.json({ ok: true });
});

router.delete("/companies/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const result = await db.execute({
    sql: "DELETE FROM companies WHERE id = ? AND user_id = ?",
    args: [id, req.user.id],
  });
  if (!result.rowsAffected) throw new HttpError(404, "Company not found.");
  await syncCompanySubmission(req.user.id);
  res.json({ ok: true });
});

export default router;
