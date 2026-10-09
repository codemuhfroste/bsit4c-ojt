import express from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";
import { db, initDb } from "./db.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72; // bcrypt ignores bytes past 72

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

app.post(
  "/api/register",
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }
    if (Buffer.byteLength(password) > MAX_PASSWORD) {
      return res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD} bytes.` });
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      await db.execute({
        sql: "INSERT INTO users (email, password_hash) VALUES (?, ?)",
        args: [email, hash],
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      if (String(err?.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "That email is already registered." });
      }
      console.error(err);
      res.status(500).json({ error: "Something went wrong. Try again." });
    }
  },
);

await initDb();
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
