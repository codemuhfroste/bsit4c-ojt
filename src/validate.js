import { HttpError } from "./auth.js";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72; // bcrypt ignores bytes past 72

export function parseEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Enter a valid email address.");
  return email;
}

export function parsePassword(value) {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (Buffer.byteLength(password) > MAX_PASSWORD)
    throw new HttpError(400, `Password must be at most ${MAX_PASSWORD} bytes.`);
  return password;
}

// Trimmed string with a length cap; `required` rejects empty values.
export function parseText(value, label, max, { required = false } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new HttpError(400, `${label} is required.`);
  if (text.length > max) throw new HttpError(400, `${label} must be at most ${max} characters.`);
  return text;
}

export function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, "Not found.");
  return id;
}

export function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "Due date must look like YYYY-MM-DD.");
  }
  return value;
}

// A Facebook page or website. A missing scheme is added; only http(s) links are accepted.
export function parseLink(value) {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, "Add the company's Facebook page or website.");
  if (text.length > 300) throw new HttpError(400, "That link is too long.");
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "That link does not look valid.");
  }
  if (!url.hostname.includes(".")) throw new HttpError(400, "That link does not look valid.");
  return url.href;
}
