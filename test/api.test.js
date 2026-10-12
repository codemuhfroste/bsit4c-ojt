import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ojt-test-"));
process.env.NODE_ENV = "test";
process.env.TURSO_DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.ADMIN_EMAILS = "admin@example.com";
delete process.env.SMTP_URL;

const { createApp } = await import("../src/app.js");
const { migrate, db } = await import("../src/db.js");
const { outbox } = await import("../src/mailer.js");

const PASSWORD = "correct horse";
let server;
let base;

// Minimal client with a cookie jar per instance.
function client() {
  let cookie = "";
  return async function call(method, url, { json, form, headers = {} } = {}) {
    const init = { method, headers: { ...headers, ...(cookie && { cookie }) } };
    if (json !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form) {
      init.body = form;
    }
    const res = await fetch(base + url, init);
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.startsWith("sid=;") ? "" : set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    const body = type.includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, body, headers: res.headers };
  };
}

const lastMailToken = (to, param) => {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes(`?${param}=`));
  return mail.text.match(new RegExp(`\\?${param}=([\\w-]+)`))[1];
};

async function registerAndVerify(email) {
  const c = client();
  const reg = await c("POST", "/api/register", { json: { email, password: PASSWORD, fullName: "Test User" } });
  assert.equal(reg.status, 201);
  const ver = await c("POST", "/api/verify", { json: { token: lastMailToken(email, "verify") } });
  assert.equal(ver.status, 200);
  return c;
}

const pdf = (text = "hello") => new Blob([`%PDF-1.4\n${text}`], { type: "application/pdf" });
const upload = (blob, name = "doc.pdf") => {
  const form = new FormData();
  form.append("file", blob, name);
  return form;
};

before(async () => {
  await migrate();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may keep the SQLite file locked briefly; the OS temp dir is cleaned up eventually.
  }
});

describe("registration and login", () => {
  test("validates input", async () => {
    const c = client();
    assert.equal((await c("POST", "/api/register", { json: { email: "nope", password: PASSWORD } })).status, 400);
    assert.equal((await c("POST", "/api/register", { json: { email: "a@b.co", password: "short" } })).status, 400);
    assert.equal(
      (await c("POST", "/api/register", { json: { email: "a@b.co", password: "x".repeat(73) } })).status,
      400,
    );
  });

  test("registers, logs in, rejects duplicates, logs out", async () => {
    const c = client();
    const reg = await c("POST", "/api/register", { json: { email: "Dup@Example.com", password: PASSWORD } });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, "dup@example.com");
    assert.equal(reg.body.user.role, "student");
    assert.equal(reg.body.user.emailVerified, false);
    assert.ok(reg.body.user.joined);
    assert.equal("section" in reg.body.user, false);
    assert.equal((await c("GET", "/api/me")).body.user.email, "dup@example.com");

    const again = await client()("POST", "/api/register", { json: { email: "dup@example.com", password: PASSWORD } });
    assert.equal(again.status, 409);

    assert.equal((await c("POST", "/api/logout")).status, 200);
    assert.equal((await c("GET", "/api/me")).status, 401);

    const bad = await client()("POST", "/api/login", {
      json: { email: "dup@example.com", password: "wrong password" },
    });
    assert.equal(bad.status, 401);
    const ok = client();
    assert.equal(
      (await ok("POST", "/api/login", { json: { email: "dup@example.com", password: PASSWORD } })).status,
      200,
    );
    assert.equal((await ok("GET", "/api/me")).status, 200);
  });

  test("blocks cross-site writes", async () => {
    const res = await client()("POST", "/api/login", {
      json: { email: "x@y.co", password: PASSWORD },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
  });

  test("ADMIN_EMAILS grants admin", async () => {
    const c = client();
    const reg = await c("POST", "/api/register", { json: { email: "admin@example.com", password: PASSWORD } });
    assert.equal(reg.body.user.role, "admin");
  });
});

describe("email verification and password reset", () => {
  test("verifies an email once", async () => {
    const c = client();
    await c("POST", "/api/register", { json: { email: "verify@example.com", password: PASSWORD } });
    const token = lastMailToken("verify@example.com", "verify");
    assert.equal((await c("POST", "/api/verify", { json: { token } })).status, 200);
    assert.equal((await c("GET", "/api/me")).body.user.emailVerified, true);
    assert.equal((await c("POST", "/api/verify", { json: { token } })).status, 400);
  });

  test("resets a password and signs out other sessions", async () => {
    const email = "reset@example.com";
    const old = await registerAndVerify(email);

    const anon = client();
    assert.equal((await anon("POST", "/api/password/forgot", { json: { email } })).status, 200);
    assert.equal((await anon("POST", "/api/password/forgot", { json: { email: "ghost@example.com" } })).status, 200);

    const token = lastMailToken(email, "reset");
    assert.equal((await anon("POST", "/api/password/reset", { json: { token, password: "short" } })).status, 400);
    assert.equal(
      (await anon("POST", "/api/password/reset", { json: { token, password: "a brand new one" } })).status,
      200,
    );
    assert.equal(
      (await anon("POST", "/api/password/reset", { json: { token, password: "a brand new one" } })).status,
      400,
    );

    assert.equal((await old("GET", "/api/me")).status, 401);
    const login = client();
    assert.equal((await login("POST", "/api/login", { json: { email, password: "a brand new one" } })).status, 200);
  });

  test("changes password with the current one", async () => {
    const c = await registerAndVerify("change@example.com");
    const wrong = await c("POST", "/api/me/password", {
      json: { currentPassword: "nope nope", newPassword: "another one 1" },
    });
    assert.equal(wrong.status, 400);
    const ok = await c("POST", "/api/me/password", {
      json: { currentPassword: PASSWORD, newPassword: "another one 1" },
    });
    assert.equal(ok.status, 200);
    assert.equal((await c("GET", "/api/me")).status, 200);
  });
});

describe("checklist", () => {
  test("requires login and lists seeded requirements", async () => {
    assert.equal((await client()("GET", "/api/requirements")).status, 401);
    const c = await registerAndVerify("list@example.com");
    const { body } = await c("GET", "/api/requirements");
    assert.ok(body.items.length >= 8);
    assert.deepEqual([...new Set(body.items.map((i) => i.phase))], ["Before OJT", "During OJT", "After OJT"]);
    assert.equal(body.progress.approved, 0);
  });

  test("unverified users cannot submit", async () => {
    const c = client();
    await c("POST", "/api/register", { json: { email: "unverified@example.com", password: PASSWORD } });
    const res = await c("POST", "/api/requirements/1/submit", { form: upload(pdf()) });
    assert.equal(res.status, 403);
  });

  test("validates uploads", async () => {
    const c = await registerAndVerify("upload@example.com");
    assert.equal((await c("POST", "/api/requirements/1/submit", { form: new FormData() })).status, 400);
    const disguised = upload(new Blob(["not really a pdf"], { type: "application/pdf" }));
    assert.equal((await c("POST", "/api/requirements/1/submit", { form: disguised })).status, 400);
    const wrongType = upload(new Blob(["x"], { type: "text/html" }), "x.html");
    assert.equal((await c("POST", "/api/requirements/1/submit", { form: wrongType })).status, 400);
    const huge = upload(new Blob(["%PDF", Buffer.alloc(6 * 1024 * 1024)], { type: "application/pdf" }));
    assert.equal((await c("POST", "/api/requirements/1/submit", { form: huge })).status, 413);
  });

  test("submit, review, download and permissions", async () => {
    const student = await registerAndVerify("student@example.com");
    const other = await registerAndVerify("other@example.com");
    const admin = client();
    await admin("POST", "/api/login", { json: { email: "admin@example.com", password: PASSWORD } });

    const sub = await student("POST", "/api/requirements/1/submit", { form: upload(pdf("v1")) });
    assert.equal(sub.status, 200);
    const item = (await student("GET", "/api/requirements")).body.items.find((i) => i.id === 1);
    assert.equal(item.submission.status, "submitted");
    const subId = item.submission.id;

    const file = await student("GET", `/api/submissions/${subId}/file`);
    assert.equal(file.status, 200);
    assert.match(Buffer.from(file.body).toString(), /v1/);
    assert.equal((await other("GET", `/api/submissions/${subId}/file`)).status, 404);

    assert.equal((await student("GET", "/api/admin/submissions")).status, 403);
    assert.equal(
      (await admin("POST", `/api/admin/submissions/${subId}/review`, { json: { status: "rejected" } })).status,
      400,
    );
    assert.equal(
      (await admin("POST", `/api/admin/submissions/${subId}/review`, { json: { status: "rejected", note: "Blurry" } }))
        .status,
      200,
    );
    const rejected = (await student("GET", "/api/requirements")).body.items.find((i) => i.id === 1);
    assert.equal(rejected.submission.status, "rejected");
    assert.equal(rejected.submission.note, "Blurry");

    // Re-upload replaces the old file on disk and resets the status.
    assert.equal((await student("POST", "/api/requirements/1/submit", { form: upload(pdf("v2")) })).status, 200);
    const replaced = await student("GET", `/api/submissions/${subId}/file`);
    assert.match(Buffer.from(replaced.body).toString(), /v2/);
    const queue = await admin("GET", "/api/admin/submissions?status=submitted");
    assert.ok(queue.body.submissions.some((s) => s.id === subId));

    assert.equal(
      (await admin("POST", `/api/admin/submissions/${subId}/review`, { json: { status: "approved" } })).status,
      200,
    );
    assert.equal((await student("POST", "/api/requirements/1/submit", { form: upload(pdf()) })).status, 409);
    assert.equal((await student("DELETE", "/api/requirements/1/submission")).status, 409);

    const users = await admin("GET", "/api/admin/users");
    assert.equal(users.body.users.find((u) => u.email === "student@example.com").approved, 1);
  });

  test("withdrawing removes the submission and its file", async () => {
    const c = await registerAndVerify("withdraw@example.com");
    await c("POST", "/api/requirements/2/submit", { form: upload(pdf("gone")) });
    const sub = (await c("GET", "/api/requirements")).body.items.find((i) => i.id === 2).submission;
    assert.equal((await c("GET", `/api/submissions/${sub.id}/file`)).status, 200);
    assert.equal((await c("DELETE", "/api/requirements/2/submission")).status, 200);
    assert.equal((await c("GET", `/api/submissions/${sub.id}/file`)).status, 404); // file is gone with the row
    assert.equal((await c("DELETE", "/api/requirements/2/submission")).status, 404);
  });
});

describe("admin", () => {
  test("manages requirements and roles", async () => {
    const admin = client();
    await admin("POST", "/api/login", { json: { email: "admin@example.com", password: PASSWORD } });
    const student = await registerAndVerify("promote@example.com");

    assert.equal((await student("POST", "/api/admin/requirements", { json: { title: "Nope" } })).status, 403);
    assert.equal((await admin("POST", "/api/admin/requirements", { json: { title: "" } })).status, 400);
    const created = await admin("POST", "/api/admin/requirements", {
      json: { title: "Orientation attendance", dueDate: "2026-11-01", requiresFile: false },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    assert.equal(
      (await admin("PUT", `/api/admin/requirements/${id}`, { json: { title: "Orientation", dueDate: "bad" } })).status,
      400,
    );
    assert.equal(
      (await admin("PUT", `/api/admin/requirements/${id}`, { json: { title: "Orientation", requiresFile: false } }))
        .status,
      200,
    );

    // A requirement without a required file can be submitted with no attachment.
    assert.equal((await student("POST", `/api/requirements/${id}/submit`, { form: new FormData() })).status, 200);

    assert.equal((await admin("DELETE", `/api/admin/requirements/${id}`)).status, 200);
    assert.equal((await admin("DELETE", `/api/admin/requirements/${id}`)).status, 404);

    const me = (await student("GET", "/api/me")).body.user;
    assert.equal((await admin("PATCH", `/api/admin/users/${me.id}/role`, { json: { role: "adviser" } })).status, 200);
    assert.equal((await student("GET", "/api/admin/users")).status, 200); // advisers can view students
    assert.equal((await student("POST", "/api/admin/requirements", { json: { title: "Nope" } })).status, 403);
    assert.equal((await admin("PATCH", `/api/admin/users/${me.id}/role`, { json: { role: "wizard" } })).status, 400);

    const adminId = (await admin("GET", "/api/me")).body.user.id;
    assert.equal((await admin("PATCH", `/api/admin/users/${adminId}/role`, { json: { role: "student" } })).status, 400);
  });
});
