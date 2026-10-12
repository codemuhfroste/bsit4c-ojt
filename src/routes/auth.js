import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { db, isUniqueViolation } from "../db.js";
import {
  HttpError,
  adminEmails,
  consumeToken,
  endAllSessions,
  endSession,
  issueToken,
  publicUser,
  requireAuth,
  startSession,
} from "../auth.js";
import { eraseUser } from "../accounts.js";
import { sendPasswordReset, sendVerification } from "../mailer.js";
import { PRIVACY_VERSION, privacyContact } from "../privacy.js";
import { parseEmail, parsePassword, parseText } from "../validate.js";

const HOUR = 60 * 60 * 1000;
const limiter = (limit) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: limit * (Number(process.env.RATE_LIMIT_SCALE) || 1), // tests raise this; production uses 1
    standardHeaders: true,
    legacyHeaders: false,
  });

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

const router = Router();

async function getUserById(id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
  return rows[0];
}

// ADMIN_EMAILS lists addresses that are admins, but only once the address has been verified. Without that check,
// anyone could register a listed address before its owner does and claim admin.
async function grantAdminIfListed(userId) {
  const { rows } = await db.execute({
    sql: "SELECT email, role, email_verified_at FROM users WHERE id = ?",
    args: [userId],
  });
  const user = rows[0];
  if (user && user.role !== "admin" && user.email_verified_at && adminEmails().has(user.email)) {
    await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [userId] });
  }
}

router.post("/register", limiter(20), async (req, res) => {
  const email = parseEmail(req.body?.email);
  const password = parsePassword(req.body?.password);
  const fullName = parseText(req.body?.fullName, "Full name", 100);
  const studentId = parseText(req.body?.studentId, "Student ID", 30);
  if (req.body?.acceptPrivacy !== true) {
    throw new HttpError(400, "Please read and accept the Privacy Notice to create an account.");
  }

  const hash = await bcrypt.hash(password, 12);
  let id;
  try {
    const result = await db.execute({
      sql: `INSERT INTO users (email, password_hash, role, full_name, student_id, privacy_accepted_at, privacy_version)
            VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
      args: [email, hash, "student", fullName, studentId, PRIVACY_VERSION],
    });
    id = Number(result.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "That email is already registered.");
    throw err;
  }

  // The account exists now; a mail failure must not fail the signup (the user can resend from the app).
  await sendVerification(email, await issueToken(id, "verify", 24 * HOUR)).catch((err) =>
    console.error("[mail] verification email failed:", err.message),
  );
  await startSession(res, id);
  res.status(201).json({ ok: true, user: publicUser(await getUserById(id)) });
});

router.post("/login", limiter(20), async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] });
  const ok = await bcrypt.compare(password, rows[0]?.password_hash ?? DUMMY_HASH);
  if (!rows[0] || !ok) throw new HttpError(401, "Wrong email or password.");

  await grantAdminIfListed(rows[0].id); // covers an admin address that was verified before it was listed
  await startSession(res, rows[0].id);
  res.json({ ok: true, user: publicUser(await getUserById(rows[0].id)) });
});

router.post("/logout", async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

router.patch("/me", requireAuth, async (req, res) => {
  const fullName = parseText(req.body?.fullName, "Full name", 100);
  const studentId = parseText(req.body?.studentId, "Student ID", 30);
  await db.execute({
    sql: "UPDATE users SET full_name = ?, student_id = ? WHERE id = ?",
    args: [fullName, studentId, req.user.id],
  });
  res.json({ ok: true, user: publicUser(await getUserById(req.user.id)) });
});

// Public: the Privacy Notice page asks who to contact and which version is current.
router.get("/privacy-info", (_req, res) => {
  res.json({ version: PRIVACY_VERSION, contact: privacyContact() });
});

// People who signed up before the notice existed (or when it changes) accept it here.
router.post("/me/privacy", requireAuth, async (req, res) => {
  if (req.body?.accept !== true)
    throw new HttpError(400, "You need to accept the Privacy Notice to keep using the app.");
  await db.execute({
    sql: "UPDATE users SET privacy_accepted_at = datetime('now'), privacy_version = ? WHERE id = ?",
    args: [PRIVACY_VERSION, req.user.id],
  });
  res.json({ ok: true, user: publicUser(await getUserById(req.user.id)) });
});

// Right to access / data portability: everything the app holds about the signed-in person, as a JSON file.
router.get("/me/export", requireAuth, async (req, res) => {
  const me = await getUserById(req.user.id);
  const { rows: companies } = await db.execute({
    sql: "SELECT * FROM companies WHERE user_id = ? ORDER BY id",
    args: [req.user.id],
  });
  const { rows: submissions } = await db.execute({
    sql: `SELECT r.title, s.status, s.note, s.file_name, s.size, s.created_at, s.updated_at, s.reviewed_at
          FROM submissions s JOIN requirements r ON r.id = s.requirement_id WHERE s.user_id = ? ORDER BY r.sort_order, r.id`,
    args: [req.user.id],
  });
  const data = {
    exportedAt: new Date().toISOString(),
    about:
      "Everything the BSIT 4C OJT Checklist holds about you. Uploaded files can be downloaded from your checklist.",
    account: {
      fullName: me.full_name,
      studentId: me.student_id,
      email: me.email,
      role: me.role,
      emailVerified: Boolean(me.email_verified_at),
      createdAt: me.created_at,
      privacyNoticeAcceptedAt: me.privacy_accepted_at,
      privacyNoticeVersion: me.privacy_version,
    },
    companies: companies.map((c) => ({
      name: c.name,
      link: c.link,
      email: c.email || "N/A",
      location: c.location === "inside" ? "Inside Legazpi" : "Outside Legazpi",
      applied: Boolean(c.applied),
      response: c.response,
      hasMoaWithUniversity: Boolean(c.moa),
      adviserReview: c.review,
      adviserNote: c.review_note,
      addedAt: c.created_at,
    })),
    submissions: submissions.map((s) => ({
      requirement: s.title,
      status: s.status,
      adviserNote: s.note,
      fileName: s.file_name,
      fileSizeBytes: s.size === null ? null : Number(s.size),
      submittedAt: s.created_at,
      updatedAt: s.updated_at,
      reviewedAt: s.reviewed_at,
    })),
  };
  res.attachment(`my-ojt-data-${new Date().toISOString().slice(0, 10)}.json`);
  res.type("application/json").send(JSON.stringify(data, null, 2));
});

// Right to erasure: delete the account and everything attached to it. Needs the password, so a borrowed session
// cannot wipe someone's data.
router.delete("/me", requireAuth, limiter(5), async (req, res) => {
  const { rows } = await db.execute({ sql: "SELECT password_hash, role FROM users WHERE id = ?", args: [req.user.id] });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!(await bcrypt.compare(password, rows[0].password_hash)))
    throw new HttpError(400, "That password is not correct.");
  if (rows[0].role === "admin") {
    const { rows: others } = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?",
      args: [req.user.id],
    });
    if (!Number(others[0].n))
      throw new HttpError(409, "You are the only admin. Make someone else an admin before deleting this account.");
  }
  await eraseUser(req.user.id);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

router.post("/me/password", requireAuth, limiter(20), async (req, res) => {
  const { rows } = await db.execute({ sql: "SELECT password_hash FROM users WHERE id = ?", args: [req.user.id] });
  const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  if (!(await bcrypt.compare(current, rows[0].password_hash)))
    throw new HttpError(400, "Current password is incorrect.");

  const hash = await bcrypt.hash(parsePassword(req.body?.newPassword), 12);
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, req.user.id] });
  await endAllSessions(req.user.id, req.sessionHash); // sign out every other device
  res.json({ ok: true });
});

router.post("/verify", limiter(30), async (req, res) => {
  const userId = await consumeToken(req.body?.token, "verify");
  if (!userId) throw new HttpError(400, "This verification link is invalid or has expired.");
  await db.execute({
    sql: "UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
    args: [new Date().toISOString(), userId],
  });
  await grantAdminIfListed(userId);
  res.json({ ok: true });
});

router.post("/verify/resend", requireAuth, limiter(5), async (req, res) => {
  if (req.user.emailVerified) return res.json({ ok: true });
  await sendVerification(req.user.email, await issueToken(req.user.id, "verify", 24 * HOUR));
  res.json({ ok: true });
});

// Always answers 200 so the endpoint cannot be used to discover registered emails.
router.post("/password/forgot", limiter(5), async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const { rows } = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  if (rows[0]) {
    // A mail failure must not change the answer, or the endpoint would reveal which emails have accounts.
    try {
      await sendPasswordReset(email, await issueToken(Number(rows[0].id), "reset", HOUR));
    } catch (err) {
      console.error("[mail] reset email failed:", err.message);
    }
  }
  res.json({ ok: true });
});

router.post("/password/reset", limiter(10), async (req, res) => {
  const password = parsePassword(req.body?.password);
  const userId = await consumeToken(req.body?.token, "reset");
  if (!userId) throw new HttpError(400, "This reset link is invalid or has expired.");

  const hash = await bcrypt.hash(password, 12);
  // Having received the emailed link also proves ownership of the address.
  await db.execute({
    sql: "UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
    args: [hash, new Date().toISOString(), userId],
  });
  await grantAdminIfListed(userId);
  await endAllSessions(userId);
  res.json({ ok: true });
});

export default router;
