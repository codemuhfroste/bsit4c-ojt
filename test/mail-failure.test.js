import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Runs in its own process: the mailer keeps its SMTP connection for the life of the process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ojt-mailfail-"));
process.env.NODE_ENV = "test";
process.env.TURSO_DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.SMTP_URL = "smtp://127.0.0.1:1"; // nothing listens here: every send fails
process.env.RATE_LIMIT_SCALE = "100";

const { createApp } = await import("../src/create-app.js");
const { migrate, db } = await import("../src/db.js");

let server;
let base;
before(async () => {
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may keep the SQLite file locked briefly
  }
});

const post = (url, json) =>
  fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });

test("signup still works when the mail server is down", async () => {
  const res = await post("/api/register", {
    acceptPrivacy: true,
    email: "down@example.com",
    password: "correct horse",
  });
  assert.equal(res.status, 201);
});

test("forgot-password gives the same answer for known and unknown emails even when mail fails", async () => {
  const known = await post("/api/password/forgot", { email: "down@example.com" });
  const unknown = await post("/api/password/forgot", { email: "nobody@example.com" });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
});
