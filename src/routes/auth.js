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
import { sendPasswordReset, sendVerification } from "../mailer.js";
import { parseEmail, parsePassword, parseText } from "../validate.js";

const HOUR = 60 * 60 * 1000;
const limiter = (limit) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false });

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

const router = Router();

async function getUserById(id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
  return rows[0];
}

// ADMIN_EMAILS lists addresses that are always admins (bootstraps the first admin).
async function applyAdminEmail(row) {
  if (row.role !== "admin" && adminEmails().has(row.email)) {
    await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [row.id] });
    return { ...row, role: "admin" };
  }
  return row;
}

router.post("/register", limiter(20), async (req, res) => {
  const email = parseEmail(req.body?.email);
  const password = parsePassword(req.body?.password);
  const fullName = parseText(req.body?.fullName, "Full name", 100);
  const studentId = parseText(req.body?.studentId, "Student ID", 30);

  const hash = await bcrypt.hash(password, 12);
  let id;
  try {
    const result = await db.execute({
      sql: `INSERT INTO users (email, password_hash, role, full_name, student_id)
            VALUES (?, ?, ?, ?, ?)`,
      args: [email, hash, adminEmails().has(email) ? "admin" : "student", fullName, studentId],
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

  const user = await applyAdminEmail(rows[0]);
  await startSession(res, user.id);
  res.json({ ok: true, user: publicUser(user) });
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
  if (rows[0]) await sendPasswordReset(email, await issueToken(Number(rows[0].id), "reset", HOUR));
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
  await endAllSessions(userId);
  res.json({ ok: true });
});

export default router;
