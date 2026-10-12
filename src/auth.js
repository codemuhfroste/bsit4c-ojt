import crypto from "node:crypto";
import { db } from "./db.js";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = "sid";

export const ROLES = ["student", "adviser", "admin"];
export const STAFF = ["adviser", "admin"];

export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function adminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function publicUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    fullName: row.full_name,
    studentId: row.student_id,
    emailVerified: Boolean(row.email_verified_at),
    joined: row.created_at,
  };
}

export async function startSession(res, userId) {
  const token = newToken();
  await db.execute({
    sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    args: [hashToken(token), userId, new Date(Date.now() + SESSION_MS).toISOString()],
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MS,
    path: "/",
  });
}

export async function endSession(req, res) {
  if (req.sessionHash) await db.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [req.sessionHash] });
  res.clearCookie(COOKIE, { path: "/" });
}

export async function endAllSessions(userId, exceptHash = "") {
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", args: [userId, exceptHash] });
}

// Populates req.user / req.sessionHash when a valid session cookie is present.
export async function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const hash = hashToken(token);
    const { rows } = await db.execute({
      sql: `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`,
      args: [hash, new Date().toISOString()],
    });
    if (rows[0]) {
      req.user = publicUser(rows[0]);
      req.sessionHash = hash;
    }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) throw new HttpError(401, "Please log in.");
  next();
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) throw new HttpError(401, "Please log in.");
    if (!roles.includes(req.user.role)) throw new HttpError(403, "You do not have access to this.");
    next();
  };

export function requireVerified(req, _res, next) {
  if (!req.user.emailVerified) throw new HttpError(403, "Verify your email address first.");
  next();
}

// One-time tokens (email verification / password reset). Only the hash is stored.
export async function issueToken(userId, purpose, ttlMs) {
  const token = newToken();
  await db.execute({
    sql: "INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
    args: [hashToken(token), userId, purpose, new Date(Date.now() + ttlMs).toISOString()],
  });
  return token;
}

// Atomically marks the token used; returns the user id, or null if invalid/expired/already used.
export async function consumeToken(token, purpose) {
  if (typeof token !== "string" || !token) return null;
  const { rows } = await db.execute({
    sql: `UPDATE user_tokens SET used_at = ?
          WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
          RETURNING user_id`,
    args: [new Date().toISOString(), hashToken(token), purpose, new Date().toISOString()],
  });
  return rows[0] ? Number(rows[0].user_id) : null;
}
