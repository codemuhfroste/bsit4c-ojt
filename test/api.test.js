import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ojt-test-"));
process.env.NODE_ENV = "test";
process.env.TURSO_DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.ADMIN_EMAILS = "admin@example.com";
process.env.PRIVACY_CONTACT = "privacy@example.com";
process.env.RATE_LIMIT_SCALE = "100"; // the suite signs up far more accounts than one real client would
delete process.env.SMTP_URL;

const { createApp } = await import("../src/create-app.js");
const { migrate, db } = await import("../src/db.js");
const { outbox } = await import("../src/mailer.js");
const { issueToken } = await import("../src/auth.js");

const PASSWORD = "correct horse";
const RESUME = 5; // seeded id of "Resume / CV", one of the two requirements open for now
const COMPANIES = 9; // seeded id of "Find OJT companies"
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
  const reg = await c("POST", "/api/register", {
    json: { acceptPrivacy: true, email, password: PASSWORD, fullName: "Test User" },
  });
  assert.equal(reg.status, 201);
  // Ordinary signups are sent no verification email (nobody has to verify); an ADMIN_EMAILS address is.
  if (outbox.some((m) => m.to === email && m.text.includes("?verify="))) {
    const ver = await c("POST", "/api/verify", { json: { token: lastMailToken(email, "verify") } });
    assert.equal(ver.status, 200);
  }
  return c;
}

// One shared admin session keeps the suite under the login rate limit.
let adminSession;
async function adminClient() {
  if (!adminSession) {
    adminSession = client();
    const login = () =>
      adminSession("POST", "/api/login", { json: { email: "admin@example.com", password: PASSWORD } });
    if ((await login()).status === 401) {
      // not registered yet (this file run in isolation): create and verify it, then log in
      adminSession = await registerAndVerify("admin@example.com");
      await login();
    }
  }
  return adminSession;
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
    assert.equal(
      (await c("POST", "/api/register", { json: { acceptPrivacy: true, email: "nope", password: PASSWORD } })).status,
      400,
    );
    assert.equal(
      (await c("POST", "/api/register", { json: { acceptPrivacy: true, email: "a@b.co", password: "short" } })).status,
      400,
    );
    assert.equal(
      (await c("POST", "/api/register", { json: { acceptPrivacy: true, email: "a@b.co", password: "x".repeat(73) } }))
        .status,
      400,
    );
  });

  test("registers, logs in, rejects duplicates, logs out", async () => {
    const c = client();
    const reg = await c("POST", "/api/register", {
      json: { acceptPrivacy: true, email: "Dup@Example.com", password: PASSWORD },
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.email, "dup@example.com");
    assert.equal(reg.body.user.role, "student");
    assert.equal(reg.body.user.emailVerified, false);
    assert.ok(reg.body.user.joined);
    assert.equal("section" in reg.body.user, false);
    assert.equal((await c("GET", "/api/me")).body.user.email, "dup@example.com");

    const again = await client()("POST", "/api/register", {
      json: { acceptPrivacy: true, email: "dup@example.com", password: PASSWORD },
    });
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

  test("ADMIN_EMAILS grants admin only after the address is verified", async () => {
    // Someone registering a listed address without owning it must not become admin or see student data.
    const squatter = client();
    const reg = await squatter("POST", "/api/register", {
      json: { acceptPrivacy: true, email: "admin@example.com", password: PASSWORD },
    });
    assert.equal(reg.body.user.role, "student");
    assert.equal(reg.body.user.emailVerified, false);
    assert.equal((await squatter("GET", "/api/admin/users")).status, 403);
    assert.equal((await squatter("GET", "/api/admin/export/companies.csv")).status, 403);
    const login = await client()("POST", "/api/login", { json: { email: "admin@example.com", password: PASSWORD } });
    assert.equal(login.body.user.role, "student"); // logging in does not promote an unverified address either

    // The real owner proves the address by following the emailed link.
    await squatter("POST", "/api/verify", { json: { token: lastMailToken("admin@example.com", "verify") } });
    assert.equal((await squatter("GET", "/api/me")).body.user.role, "admin");
    assert.equal((await squatter("GET", "/api/admin/users")).status, 200);
  });

  test("an admin email is also promoted when its owner resets the password", async () => {
    const email = "admin@example.com";
    const owner = client();
    await owner("POST", "/api/password/forgot", { json: { email } });
    const token = lastMailToken(email, "reset");
    assert.equal((await owner("POST", "/api/password/reset", { json: { token, password: PASSWORD } })).status, 200);
    const login = await client()("POST", "/api/login", { json: { email, password: PASSWORD } });
    assert.equal(login.body.user.role, "admin");
  });
});

describe("email verification and password reset", () => {
  test("verifies an email once", async () => {
    const c = client();
    await c("POST", "/api/register", {
      json: { acceptPrivacy: true, email: "verify@example.com", password: PASSWORD },
    });
    const id = (await c("GET", "/api/me")).body.user.id;
    const token = await issueToken(id, "verify", 60 * 60 * 1000);
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
    assert.ok(body.items.length >= 9);
    assert.deepEqual(
      [...new Set(body.items.map((i) => i.phase))],
      ["Current tasks", "Before OJT", "During OJT", "After OJT"],
    );
    // The company list, the resume, the MoA and the forms to accomplish are open (the MoA first in "Before OJT");
    // everything else is "N/A for now" and not counted.
    assert.deepEqual(
      body.items.filter((i) => i.available).map((i) => i.title),
      [
        "Find OJT companies",
        "Resume / CV",
        "Memorandum of Agreement (MOA)",
        "Letter of Acceptance",
        "Mentorship Plan",
        "Training Agreement and Waiver",
        "Endorsement letter",
      ],
    );
    // The resume is optional: open and submittable, but not counted in progress. The endorsement letter is required.
    assert.equal(body.progress.total, 6);
    assert.deepEqual(
      body.items.filter((i) => i.optional).map((i) => i.title),
      ["Resume / CV"],
    );
    assert.equal(body.progress.approved, 0);
  });

  test("nobody has to verify an email: no verification mail, and unverified users can submit", async () => {
    const c = client();
    await c("POST", "/api/register", {
      json: { acceptPrivacy: true, email: "unverified@example.com", password: PASSWORD },
    });
    assert.ok(!outbox.some((m) => m.to === "unverified@example.com"), "ordinary signups are not emailed");
    const res = await c("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf()) });
    assert.equal(res.status, 200);
    assert.equal((await c("DELETE", `/api/requirements/${RESUME}/submission`)).status, 200);
  });

  test("validates uploads", async () => {
    const c = await registerAndVerify("upload@example.com");
    assert.equal((await c("POST", `/api/requirements/${RESUME}/submit`, { form: new FormData() })).status, 400);
    const disguised = upload(new Blob(["not really a pdf"], { type: "application/pdf" }));
    assert.equal((await c("POST", `/api/requirements/${RESUME}/submit`, { form: disguised })).status, 400);
    const wrongType = upload(new Blob(["x"], { type: "text/html" }), "x.html");
    assert.equal((await c("POST", `/api/requirements/${RESUME}/submit`, { form: wrongType })).status, 400);
    const huge = upload(new Blob(["%PDF", Buffer.alloc(6 * 1024 * 1024)], { type: "application/pdf" }));
    assert.equal((await c("POST", `/api/requirements/${RESUME}/submit`, { form: huge })).status, 413);
  });

  test("submit, review, download and permissions", async () => {
    const student = await registerAndVerify("student@example.com");
    const other = await registerAndVerify("other@example.com");
    const admin = await adminClient();

    const sub = await student("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("v1")) });
    assert.equal(sub.status, 200);
    const item = (await student("GET", "/api/requirements")).body.items.find((i) => i.id === RESUME);
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
    const rejected = (await student("GET", "/api/requirements")).body.items.find((i) => i.id === RESUME);
    assert.equal(rejected.submission.status, "rejected");
    assert.equal(rejected.submission.note, "Blurry");

    // Re-upload replaces the old file on disk and resets the status.
    assert.equal(
      (await student("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("v2")) })).status,
      200,
    );
    const replaced = await student("GET", `/api/submissions/${subId}/file`);
    assert.match(Buffer.from(replaced.body).toString(), /v2/);
    const queue = await admin("GET", "/api/admin/submissions?status=submitted");
    assert.ok(queue.body.submissions.some((s) => s.id === subId));

    assert.equal(
      (await admin("POST", `/api/admin/submissions/${subId}/review`, { json: { status: "approved" } })).status,
      200,
    );
    assert.equal((await student("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf()) })).status, 409);
    assert.equal((await student("DELETE", `/api/requirements/${RESUME}/submission`)).status, 409);

    const users = await admin("GET", "/api/admin/users");
    // An approved optional requirement does not count toward the student's progress.
    assert.equal(users.body.totalRequirements, 6);
    assert.equal(users.body.users.find((u) => u.email === "student@example.com").approved, 0);
  });

  test("withdrawing removes the submission and its file", async () => {
    const c = await registerAndVerify("withdraw@example.com");
    await c("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("gone")) });
    const sub = (await c("GET", "/api/requirements")).body.items.find((i) => i.id === RESUME).submission;
    assert.equal((await c("GET", `/api/submissions/${sub.id}/file`)).status, 200);
    assert.equal((await c("DELETE", `/api/requirements/${RESUME}/submission`)).status, 200);
    assert.equal((await c("GET", `/api/submissions/${sub.id}/file`)).status, 404); // file is gone with the row
    assert.equal((await c("DELETE", `/api/requirements/${RESUME}/submission`)).status, 404);
  });
});

describe("admin", () => {
  test("manages requirements and roles", async () => {
    const admin = await adminClient();
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

describe("current tasks", () => {
  test("closed requirements cannot be submitted", async () => {
    const c = await registerAndVerify("closed@example.com");
    const res = await c("POST", "/api/requirements/1/submit", { form: upload(pdf()) });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /not open/i);
  });

  test("company list: validation, automatic submission, review", async () => {
    const student = await registerAndVerify("shopper@example.com");
    const other = await registerAndVerify("shopper2@example.com");
    const admin = await adminClient();
    const add = (c, body) => c("POST", "/api/companies", { json: { email: "N/A", ...body } });
    const state = async (c) =>
      (await c("GET", "/api/requirements")).body.items.find((i) => i.id === COMPANIES).submission;

    // Nothing is submitted until a company exists, and there is no manual submit for this task.
    assert.equal(await state(student), null);
    assert.equal(
      (await student("POST", `/api/requirements/${COMPANIES}/submit`, { form: new FormData() })).status,
      400,
    );

    assert.equal((await add(student, { name: "", link: "acme.com", location: "inside" })).status, 400);
    assert.equal((await add(student, { name: "Acme", link: "javascript:alert(1)", location: "inside" })).status, 400);
    assert.equal((await add(student, { name: "Acme", link: "acme.com", location: "mars" })).status, 400);
    assert.equal(await state(student), null); // failed attempts submit nothing

    // The first valid company completes the task by itself: no adviser reviews the list.
    const first = await add(student, { name: "Acme Corp", link: "facebook.com/acme", location: "inside" });
    assert.equal(first.status, 201);
    assert.equal((await state(student)).status, "approved");
    assert.equal(
      (await add(student, { name: "Beta IT", link: "https://beta.example.com", location: "outside" })).status,
      201,
    );

    const list = (await student("GET", "/api/companies")).body.companies;
    assert.deepEqual(
      list.map((c) => [c.name, c.link, c.location]),
      [
        ["Acme Corp", "https://facebook.com/acme", "inside"],
        ["Beta IT", "https://beta.example.com/", "outside"],
      ],
    );
    assert.equal((await other("GET", "/api/companies")).body.companies.length, 0);
    assert.equal((await other("DELETE", `/api/companies/${first.body.id}`)).status, 404); // not theirs
    assert.equal((await student("DELETE", `/api/requirements/${COMPANIES}/submission`)).status, 400); // no manual withdraw

    assert.equal(
      (
        await student("PUT", `/api/companies/${first.body.id}`, {
          json: { name: "Acme Inc", link: "acme.com", email: "N/A", location: "outside" },
        })
      ).status,
      200,
    );

    // Staff still see the list next to the submission, but it never waits in the "needs review" queue.
    assert.equal(
      (await admin("GET", "/api/admin/submissions?status=submitted")).body.submissions.some(
        (s) => s.email === "shopper@example.com",
      ),
      false,
    );
    const queue = (await admin("GET", "/api/admin/submissions?status=approved")).body.submissions;
    const entry = queue.find((s) => s.email === "shopper@example.com");
    assert.equal(entry.kind, "companies");
    assert.deepEqual(
      entry.companies.map((c) => c.name),
      ["Acme Inc", "Beta IT"],
    );

    // Even if it was sent back by hand, adding another company puts it straight back to done.
    await admin("POST", `/api/admin/submissions/${entry.id}/review`, {
      json: { status: "rejected", note: "Need more" },
    });
    assert.equal((await state(student)).status, "rejected");
    assert.equal((await add(student, { name: "Gamma", link: "gamma.example.com", location: "inside" })).status, 201);
    assert.equal((await state(student)).status, "approved");

    // Students can keep adding, editing and removing companies.
    assert.equal((await add(student, { name: "Delta", link: "delta.example.com", location: "outside" })).status, 201);
    assert.equal((await state(student)).status, "approved");
    assert.equal((await student("DELETE", `/api/companies/${first.body.id}`)).status, 200);
    assert.equal((await student("GET", "/api/companies")).body.companies.length, 3);
  });

  test("a student accepted by several companies picks one final company", async () => {
    const student = await registerAndVerify("final@example.com");
    const other = await registerAndVerify("final2@example.com");
    const admin = await adminClient();
    const add = async (name, extra) =>
      (
        await student("POST", "/api/companies", {
          json: { name, link: "", email: "N/A", location: "inside", applied: true, ...extra },
        })
      ).body.id;
    const [alpha, beta, gamma] = [
      await add("Alpha", { response: "accepted" }),
      await add("Beta", { response: "accepted" }),
      await add("Gamma", { response: "denied" }),
    ];
    const finals = async () => (await student("GET", "/api/companies")).body.companies.map((c) => c.isFinal);
    const choose = (id, final) => student("PATCH", `/api/companies/${id}`, { json: { final } });

    assert.deepEqual(await finals(), [false, false, false]);
    assert.equal((await choose(gamma, true)).status, 400); // only a company that accepted you
    assert.equal((await choose(alpha, "yes")).status, 400);
    assert.equal((await other("PATCH", `/api/companies/${alpha}`, { json: { final: true } })).status, 404); // not theirs

    assert.equal((await choose(alpha, true)).status, 200);
    assert.deepEqual(await finals(), [true, false, false]);
    assert.equal((await choose(beta, true)).status, 200); // there is only ever one
    assert.deepEqual(await finals(), [false, true, false]);

    // Staff see it in the Tracker.
    const row = (await admin("GET", "/api/admin/tracker")).body.students.find((s) => s.email === "final@example.com");
    assert.deepEqual(
      row.companyList.map((c) => [c.name, c.final]),
      [
        ["Alpha", false],
        ["Beta", true],
        ["Gamma", false],
      ],
    );

    // A company that stops saying "accepted" is no longer the final one.
    assert.equal((await student("PATCH", `/api/companies/${beta}`, { json: { response: "denied" } })).status, 200);
    assert.deepEqual(await finals(), [false, false, false]);
    assert.equal((await choose(alpha, true)).status, 200);
    assert.equal((await choose(alpha, false)).status, 200);
    assert.deepEqual(await finals(), [false, false, false]);
  });

  test("a groupmate's MoA covers students whose final company is (nearly) the same", async () => {
    const admin = await adminClient();
    const mk = async (email, company, response = "accepted") => {
      const c = await registerAndVerify(email);
      await c("POST", "/api/companies", {
        json: { name: company, link: "", email: "N/A", location: "inside", applied: true, response },
      });
      return c;
    };
    const first = await mk("group-a@example.com", "Quanby Solutions, Inc.");
    const second = await mk("group-b@example.com", "Quanby Solutions");
    const other = await mk("group-c@example.com", "Quanby Labs"); // a different company
    const waiting = await mk("group-d@example.com", "Quanby Solutions", "none"); // has not accepted: no final company
    const moaOf = async (c) =>
      (await c("GET", "/api/requirements")).body.items.find((i) => /^Memorandum/.test(i.title));
    const moaId = (await moaOf(first)).id;

    assert.equal((await moaOf(second)).submission, null); // nobody has submitted yet
    assert.equal((await first("POST", `/api/requirements/${moaId}/submit`, { form: upload(pdf("moa")) })).status, 200);

    // The groupmate is covered, as "submitted", and it counts in their progress.
    const covered = await moaOf(second);
    assert.equal(covered.submission.viaGroup, true);
    assert.equal(covered.submission.status, "submitted");
    assert.equal(covered.submission.groupmate, undefined); // students are not told whose it is
    assert.equal((await second("GET", "/api/requirements")).body.progress.submitted, 2); // company list + MoA
    // Nobody else is.
    assert.equal((await moaOf(other)).submission, null);
    assert.equal((await moaOf(waiting)).submission, null);

    // Staff see whose MoA it is, and cannot review something that is not the student's own.
    const secondId = (await second("GET", "/api/me")).body.user.id;
    const detail = (await admin("GET", `/api/admin/users/${secondId}`)).body.items.find((i) => i.id === moaId);
    assert.deepEqual(
      [detail.submission.viaGroup, detail.submission.groupmate, detail.submission.id],
      [true, "Test User", null],
    );
    const tracker = (await admin("GET", "/api/admin/tracker")).body.students;
    const cell = tracker.find((x) => x.email === "group-b@example.com").cells[moaId];
    assert.deepEqual([cell.status, cell.viaGroup, cell.groupmate], ["submitted", true, "Test User"]);
    assert.equal(tracker.find((x) => x.email === "group-c@example.com").cells[moaId], undefined);
    // ...and it is not something waiting in the review queue or the "awaiting review" count.
    const queue = (await admin("GET", "/api/admin/submissions?status=submitted")).body.submissions;
    assert.equal(queue.filter((x) => x.requirement === covered.title).length >= 1, true);
    assert.equal(
      queue.some((x) => x.email === "group-b@example.com"),
      false,
    );
    const listed = (await admin("GET", "/api/admin/users")).body.users.find((u) => u.email === "group-b@example.com");
    assert.deepEqual([listed.submitted, listed.inReview], [2, 0]);
    const csv = Buffer.from((await admin("GET", "/api/admin/export/progress.csv")).body).toString("utf8");
    assert.match(
      csv.split("\r\n").find((l) => l.includes("group-b@example.com")),
      /Submitted by groupmate/,
    );

    // Once the adviser approves the groupmate's MoA, the cover follows.
    const mine = (await moaOf(first)).submission.id;
    await admin("POST", `/api/admin/submissions/${mine}/review`, { json: { status: "approved" } });
    assert.equal((await moaOf(second)).submission.status, "approved");
    assert.equal((await second("GET", "/api/requirements")).body.progress.approved, 2);

    // A student's own submission always wins.
    assert.equal((await second("POST", `/api/requirements/${moaId}/submit`, { form: upload(pdf("own")) })).status, 200);
    const own = (await moaOf(second)).submission;
    assert.equal(own.viaGroup, undefined);
    assert.equal(own.status, "submitted");
  });

  test("company website is optional", async () => {
    const student = await registerAndVerify("nolink@example.com");
    const post = (body) => student("POST", "/api/companies", { json: { email: "N/A", location: "inside", ...body } });
    assert.equal((await post({ name: "No Link Inc", link: "" })).status, 201);
    assert.equal((await post({ name: "Missing Field Inc" })).status, 201);
    assert.equal((await post({ name: "Bad Link Inc", link: "javascript:alert(1)" })).status, 400);
    const list = (await student("GET", "/api/companies")).body.companies;
    assert.deepEqual(
      list.map((c) => [c.name, c.link]),
      [
        ["No Link Inc", ""],
        ["Missing Field Inc", ""],
      ],
    );
  });

  test("company email (N/A allowed) and applied flag", async () => {
    const student = await registerAndVerify("applies@example.com");
    const admin = await adminClient();
    const post = (body) => student("POST", "/api/companies", { json: body });
    const base = { name: "Hire Me Inc", link: "hireme.example.com", location: "inside" };

    assert.equal((await post(base)).status, 400); // email must be given, or N/A
    assert.equal((await post({ ...base, email: "" })).status, 400);
    assert.equal((await post({ ...base, email: "not-an-email" })).status, 400);

    const none = await post({ ...base, email: "n/a" });
    assert.equal(none.status, 201);
    const withMail = await post({ ...base, name: "Mailed Co", email: "HR@Mailed.example.com", applied: true });
    assert.equal(withMail.status, 201);

    const list = (await student("GET", "/api/companies")).body.companies;
    assert.deepEqual(
      list.map((c) => [c.name, c.email, c.applied]),
      [
        ["Hire Me Inc", "", false],
        ["Mailed Co", "hr@mailed.example.com", true],
      ],
    );

    // Flip "applied" the way the checklist toggle does.
    const toggled = await student("PUT", `/api/companies/${none.body.id}`, {
      json: { ...base, email: "N/A", applied: true },
    });
    assert.equal(toggled.status, 200);
    assert.equal((await student("GET", "/api/companies")).body.companies[0].applied, true);

    // Reviewers see both fields.
    const queue = (await admin("GET", "/api/admin/submissions?status=approved")).body.submissions;
    const entry = queue.find((x) => x.email === "applies@example.com");
    assert.deepEqual(
      entry.companies.map((c) => [c.email, c.applied]),
      [
        ["", true],
        ["hr@mailed.example.com", true],
      ],
    );
  });

  test("quick toggles: location, applied and response", async () => {
    const student = await registerAndVerify("toggles@example.com");
    const other = await registerAndVerify("toggles2@example.com");
    const admin = await adminClient();
    const made = await student("POST", "/api/companies", {
      json: { name: "Toggle Co", link: "toggle.example.com", email: "N/A", location: "inside" },
    });
    const id = made.body.id;
    const patch = (c, body) => c("PATCH", `/api/companies/${id}`, { json: body });
    const get = async () => (await student("GET", "/api/companies")).body.companies[0];

    // New companies start as: not applied, no response.
    assert.deepEqual([(await get()).applied, (await get()).response], [false, "none"]);

    assert.equal((await patch(student, { location: "outside" })).status, 200);
    assert.equal((await get()).location, "outside");
    assert.equal((await patch(student, { location: "mars" })).status, 400);

    // A response cannot be recorded before applying.
    assert.equal((await patch(student, { response: "accepted" })).status, 200);
    assert.equal((await get()).response, "none");

    assert.equal((await patch(student, { applied: true })).status, 200);
    assert.equal((await patch(student, { response: "accepted" })).status, 200);
    assert.deepEqual([(await get()).applied, (await get()).response], [true, "accepted"]);
    assert.equal((await patch(student, { response: "denied" })).status, 200);
    assert.equal((await get()).response, "denied");
    assert.equal((await patch(student, { response: "maybe" })).status, 400);

    // Reviewers see the response.
    const queue = (await admin("GET", "/api/admin/submissions?status=approved")).body.submissions;
    const entry = queue.find((x) => x.email === "toggles@example.com");
    assert.deepEqual(
      entry.companies.map((c) => [c.location, c.applied, c.response]),
      [["outside", true, "denied"]],
    );

    // Un-applying clears the response; other students cannot touch it.
    assert.equal((await patch(student, { applied: false })).status, 200);
    assert.deepEqual([(await get()).applied, (await get()).response], [false, "none"]);
    assert.equal((await patch(other, { applied: true })).status, 404);
  });

  test("adviser can open a student's whole checklist", async () => {
    const student = await registerAndVerify("detail@example.com");
    const other = await registerAndVerify("detail2@example.com");
    const admin = await adminClient();
    await student("POST", "/api/companies", {
      json: {
        name: "Detail Co",
        link: "detail.example.com",
        email: "hr@detail.example.com",
        location: "inside",
        applied: true,
      },
    });
    await student("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("cv")) });
    const id = (await student("GET", "/api/me")).body.user.id;

    assert.equal((await other("GET", `/api/admin/users/${id}`)).status, 403); // students cannot
    assert.equal((await admin("GET", "/api/admin/users/999999")).status, 404);

    const { body } = await admin("GET", `/api/admin/users/${id}`);
    assert.equal(body.user.email, "detail@example.com");
    assert.equal(body.companies[0].name, "Detail Co");
    assert.equal(body.companies[0].applied, true);
    const byTitle = Object.fromEntries(body.items.map((i) => [i.title, i]));
    assert.equal(byTitle["Resume / CV"].submission.status, "submitted");
    assert.equal(byTitle["Find OJT companies"].submission.status, "approved");
    assert.equal(body.progress.total, 6);

    // Reviews list the student id so the adviser can jump to the student.
    const queue = (await admin("GET", "/api/admin/submissions?status=submitted")).body.submissions;
    assert.ok(queue.some((x) => x.userId === id));
  });

  test("CSV exports are staff-only and safe to open in a spreadsheet", async () => {
    const student = await registerAndVerify("csv@example.com");
    const admin = await adminClient();
    await student("PATCH", "/api/me", { json: { fullName: '=HYPERLINK("http://evil")', studentId: "2023-9" } });
    await student("POST", "/api/companies", {
      json: { name: 'Acme, "The" Co', link: "acme.example.com", email: "N/A", location: "outside" },
    });

    assert.equal((await student("GET", "/api/admin/export/progress.csv")).status, 403);
    assert.equal((await student("GET", "/api/admin/export/companies.csv")).status, 403);

    const text = async (path) => {
      const res = await admin("GET", path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/csv/);
      assert.match(res.headers.get("content-disposition"), /attachment; filename="ojt-/);
      return Buffer.from(res.body).toString("utf8");
    };

    const progress = await text("/api/admin/export/progress.csv");
    assert.ok(
      progress.startsWith(
        "\uFEFFName,Student ID,Email,Find OJT companies,Memorandum of Agreement (MOA),Letter of Acceptance,Mentorship Plan,Training Agreement and Waiver,Endorsement letter,Required approved,Company 1",
      ),
      progress.split("\r\n")[0],
    );
    assert.ok(!progress.split("\r\n")[0].includes("Resume"), "optional tasks are not in the export");
    const row = progress.split("\r\n").find((l) => l.includes("csv@example.com"));
    assert.match(row, /^"'=HYPERLINK/); // formula neutralised (and quoted, since it contains quotes)
    assert.match(row, /,Approved,To do,To do,To do,To do,To do,1\/6,"Acme, ""The"" Co"/); // status, progress, then the exact company name

    const companies = await text("/api/admin/export/companies.csv");
    const line = companies.split("\r\n").find((l) => l.includes("csv@example.com"));
    assert.ok(line.includes('"Acme, ""The"" Co"')); // commas and quotes escaped
    assert.ok(line.includes("N/A,Outside Legazpi,No,,No,"));
    assert.ok(!companies.split("\r\n")[0].includes("Review"), "no review columns any more");
  });

  test("listing a company completes the required progress without any adviser review", async () => {
    const student = await registerAndVerify("progress@example.com");
    const before = (await student("GET", "/api/requirements")).body.progress;
    assert.deepEqual([before.approved, before.total], [0, 6]);
    await student("POST", "/api/companies", {
      json: { name: "Prog Co", link: "prog.example.com", email: "N/A", location: "inside" },
    });
    const after = (await student("GET", "/api/requirements")).body.progress;
    assert.deepEqual([after.approved, after.total], [1, 6]);
  });

  test("advisers flag a MoA on a company; students cannot, and there is no per-company review", async () => {
    const student = await registerAndVerify("reviewed@example.com");
    const other = await registerAndVerify("reviewed2@example.com");
    const admin = await adminClient();
    const mk = async (name) =>
      (
        await student("POST", "/api/companies", {
          json: { name, link: `${name}.example.com`, email: "N/A", location: "inside", moa: true },
        })
      ).body.id;
    const [first, second] = [await mk("firstco"), await mk("secondco")];
    const mine = async () => (await student("GET", "/api/companies")).body.companies;

    // Students cannot set the flag on their own (the extra field is ignored), and companies carry no review fields.
    assert.deepEqual(
      (await mine()).map((c) => c.moa),
      [false, false],
    );
    assert.ok(!("review" in (await mine())[0]) && !("reviewNote" in (await mine())[0]));
    assert.equal((await student("PATCH", `/api/admin/companies/${first}`, { json: { moa: true } })).status, 403);
    // the old per-company review endpoint is gone
    assert.equal(
      (await admin("POST", `/api/admin/companies/${first}/review`, { json: { status: "approved" } })).status,
      404,
    );

    // Only staff can set the MoA flag, and it validates its input.
    assert.equal((await admin("PATCH", `/api/admin/companies/${second}`, { json: { moa: "yes" } })).status, 400);
    assert.equal((await admin("PATCH", `/api/admin/companies/${second}`, { json: { moa: true } })).status, 200);
    assert.equal((await mine())[1].moa, true);
    assert.equal((await other("GET", "/api/companies")).body.companies.length, 0);

    // Editing the company keeps the MoA flag, which belongs to staff.
    const renamed = await student("PUT", `/api/companies/${second}`, {
      json: { name: "Second Co Renamed", link: "secondco.example.com", email: "N/A", location: "inside" },
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual((await mine())[1] && [(await mine())[1].name, (await mine())[1].moa], ["Second Co Renamed", true]);

    // The adviser sees the id and MoA flag next to the list.
    const queue = (await admin("GET", "/api/admin/submissions?status=approved")).body.submissions;
    const entry = queue.find((x) => x.email === "reviewed@example.com");
    assert.deepEqual(
      entry.companies.map((c) => [c.id, c.moa]),
      [
        [first, false],
        [second, true],
      ],
    );
  });

  test("company emails cannot carry mailto parameters or markup", async () => {
    const c = await registerAndVerify("mailto@example.com");
    const post = (email) =>
      c("POST", "/api/companies", { json: { name: "Co", link: "co.example.com", email, location: "inside" } });
    for (const bad of [
      "x@y.co?cc=attacker%40evil.com",
      "x@y.co?subject=hi",
      "a&b@y.co",
      "<b>@y.co",
      '"quoted"@y.co',
      "x@y.co,z@y.co",
      "x@y",
    ]) {
      assert.equal((await post(bad)).status, 400, `should reject ${bad}`);
    }
    for (const good of ["hr@acme.example.com", "first.last+ojt@school.edu.ph", "o'brien@co-op.example.com", "N/A"]) {
      assert.equal((await post(good)).status, 201, `should accept ${good}`);
    }
  });

  test("the company list task cannot be deleted, only closed", async () => {
    const admin = await adminClient();
    assert.equal((await admin("DELETE", `/api/admin/requirements/${COMPANIES}`)).status, 400);
    const items = (await admin("GET", "/api/requirements")).body.items;
    assert.ok(items.some((i) => i.id === COMPANIES)); // still there
  });

  test("emptying the company list removes the approval too", async () => {
    const student = await registerAndVerify("approvedempty@example.com");
    const made = await student("POST", "/api/companies", {
      json: { name: "Only Co", link: "only.example.com", email: "N/A", location: "inside" },
    });
    assert.equal(
      (await student("GET", "/api/requirements")).body.items.find((i) => i.id === COMPANIES).submission.status,
      "approved",
    );
    assert.equal((await student("DELETE", `/api/companies/${made.body.id}`)).status, 200);
    const after = (await student("GET", "/api/requirements")).body;
    assert.equal(after.items.find((i) => i.id === COMPANIES).submission, null);
    assert.equal(after.progress.approved, 0); // no "Done" with nothing in it
  });

  test("student list never counts the company list as waiting for review", async () => {
    const student = await registerAndVerify("counts@example.com");
    const admin = await adminClient();
    await student("POST", "/api/companies", {
      json: { name: "Count Co", link: "count.example.com", email: "N/A", location: "inside" },
    });
    const row = (await admin("GET", "/api/admin/users")).body.users.find((u) => u.email === "counts@example.com");
    assert.deepEqual([row.inReview, row.approved], [0, 1]);
  });

  test("tracker grid: one row per student with every requirement's status and the company numbers", async () => {
    const admin = await adminClient();
    const done = await registerAndVerify("grid-done@example.com");
    const waiting = await registerAndVerify("grid-waiting@example.com");
    const nothing = client();
    await nothing("POST", "/api/register", {
      json: { acceptPrivacy: true, email: "grid-nothing@example.com", password: PASSWORD, fullName: "Zed Nothing" },
    });

    // done: company listed + resume approved; waiting: two companies listed; nothing: no activity
    await done("POST", "/api/companies", {
      json: {
        name: "Done Co",
        link: "done.example.com",
        email: "N/A",
        location: "inside",
        applied: true,
        response: "accepted",
      },
    });
    await waiting("POST", "/api/companies", {
      json: { name: "Wait Co", link: "wait.example.com", email: "N/A", location: "outside" },
    });
    await waiting("POST", "/api/companies", {
      json: { name: "Wait Co 2", link: "wait2.example.com", email: "N/A", location: "inside", applied: true },
    });
    await done("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("cv")) });
    const mine = async (c) => (await c("GET", "/api/requirements")).body.items;
    const resumeSub = (await mine(done)).find((i) => i.id === RESUME).submission.id;
    await admin("POST", `/api/admin/submissions/${resumeSub}/review`, { json: { status: "approved" } });

    const { status, body } = await admin("GET", "/api/admin/tracker");
    assert.equal(status, 200);
    assert.deepEqual(
      body.requirements.filter((r) => r.available).map((r) => [r.title, r.optional]),
      [
        ["Find OJT companies", false],
        ["Resume / CV", true],
        ["Memorandum of Agreement (MOA)", false],
        ["Letter of Acceptance", false],
        ["Mentorship Plan", false],
        ["Training Agreement and Waiver", false],
        ["Endorsement letter", false],
      ],
    );
    assert.ok(
      body.requirements.some((r) => !r.available),
      "closed (N/A) requirements are listed too, flagged unavailable",
    );
    const by = Object.fromEntries(body.students.map((s) => [s.email, s]));
    assert.ok("admin@example.com" in by, "admins are rows too (the coordinator is in the class)");

    const a = by["grid-done@example.com"];
    assert.equal(a.cells[COMPANIES].status, "approved");
    assert.equal(a.cells[RESUME].status, "approved");
    assert.deepEqual([a.companies.total, a.companies.applied, a.companies.accepted], [1, 1, 1]);
    const w = by["grid-waiting@example.com"];
    assert.equal(w.cells[COMPANIES].status, "approved"); // listing a company is all it takes
    assert.equal(w.cells[RESUME], undefined); // no submission means "missing" on the grid
    assert.deepEqual([w.companies.total, w.companies.applied, w.companies.inside], [2, 1, 1]);
    const z = by["grid-nothing@example.com"];
    assert.deepEqual(z.cells, {});
    assert.equal(z.companies.total, 0);
    assert.deepEqual(z.companyList, []);
    assert.deepEqual(
      a.companyList.map((c) => [c.name, c.applied, c.response]),
      [["Done Co", true, "accepted"]],
    );
    assert.deepEqual(
      w.companyList.map((c) => [c.name, c.location]),
      [
        ["Wait Co", "outside"],
        ["Wait Co 2", "inside"],
      ],
    ); // exact names, in the order they were added
    assert.ok(a.lastActivity && z.lastActivity, "everyone has a last-activity time (at least their signup)");
    assert.ok(!JSON.stringify(body).match(/password|hash/i), "nothing sensitive in the grid data");
  });

  test("progress export is the grid in Excel form: exact company names in Company 1..N", async () => {
    const admin = await adminClient();
    const c = await registerAndVerify("excel@example.com");
    await c("PATCH", "/api/me", { json: { fullName: "Excel Student", studentId: "2023-42" } });
    for (const name of ["Acme Software Inc.", "Beta, Digital & Co", "Gamma Labs"]) {
      await c("POST", "/api/companies", { json: { name, link: "x.example.com", email: "N/A", location: "inside" } });
    }
    const res = await admin("GET", "/api/admin/export/progress.csv");
    const lines = Buffer.from(res.body).toString("utf8").split("\r\n");
    const header = lines[0].replace("\uFEFF", "").split(",");
    const slots = header.filter((h) => /^Company \d+$/.test(h));
    assert.ok(slots.length >= 3, "one column per company slot, as many as the busiest student needs");
    assert.deepEqual(
      slots,
      slots.map((_, i) => `Company ${i + 1}`),
    );
    assert.ok(!header.some((h) => /optional|Resume/i.test(h)));
    const row = lines.find((l) => l.includes("excel@example.com"));
    assert.ok(row.includes('Acme Software Inc.,"Beta, Digital & Co",Gamma Labs'), row); // names only, in order, quoted when needed
  });

  test("emptying the company list puts the task back to to-do", async () => {
    const c = await registerAndVerify("empties@example.com");
    const { body } = await c("POST", "/api/companies", {
      json: { name: "Solo Co", link: "solo.example.com", email: "N/A", location: "inside" },
    });
    const sub = async () => (await c("GET", "/api/requirements")).body.items.find((i) => i.id === COMPANIES).submission;
    assert.equal((await sub()).status, "approved");
    assert.equal((await c("DELETE", `/api/companies/${body.id}`)).status, 200);
    assert.equal(await sub(), null);
  });

  test("admins can close and reopen a requirement", async () => {
    const admin = await adminClient();
    const student = await registerAndVerify("reopen@example.com");
    const body = { title: "Seminar certificate", requiresFile: false, available: false };
    const { body: created } = await admin("POST", "/api/admin/requirements", { json: body });
    const find = async () => (await student("GET", "/api/requirements")).body.items.find((i) => i.id === created.id);

    assert.equal((await find()).available, false);
    assert.equal(
      (await student("POST", `/api/requirements/${created.id}/submit`, { form: new FormData() })).status,
      409,
    );
    await admin("PUT", `/api/admin/requirements/${created.id}`, { json: { ...body, available: true } });
    assert.equal((await find()).available, true);
    assert.equal(
      (await student("POST", `/api/requirements/${created.id}/submit`, { form: new FormData() })).status,
      200,
    );
  });
});

describe("authorization matrix", () => {
  test("every protected endpoint answers each role correctly", async () => {
    const anon = client();
    const student = await registerAndVerify("matrix-student@example.com");
    const adviser = await registerAndVerify("matrix-adviser@example.com");
    const admin = await adminClient();
    const adviserId = (await adviser("GET", "/api/me")).body.user.id;
    assert.equal(
      (await admin("PATCH", `/api/admin/users/${adviserId}/role`, { json: { role: "adviser" } })).status,
      200,
    );
    const adminId = (await admin("GET", "/api/me")).body.user.id;

    // [method, path, body, expected for: anon, student, adviser, admin]. 0 = any non-401/403 (route-specific result).
    const staffRead = [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/submissions"],
      ["GET", "/api/admin/tracker"],
      ["GET", `/api/admin/users/${adminId}`],
      ["GET", "/api/admin/export/progress.csv"],
      ["GET", "/api/admin/export/companies.csv"],
    ];
    const staffWrite = [
      ["POST", "/api/admin/submissions/999999/review", { status: "approved" }],
      ["PATCH", "/api/admin/companies/999999", { moa: true }],
    ];
    const adminOnly = [
      ["POST", "/api/admin/requirements", {}],
      ["PUT", "/api/admin/requirements/999999", {}],
      ["DELETE", "/api/admin/requirements/999999"],
      ["PATCH", `/api/admin/users/${adminId}/role`, { role: "admin" }],
      ["DELETE", `/api/admin/users/999999/sessions`],
      ["DELETE", "/api/admin/users/999999"],
    ];
    const signedIn = [
      ["GET", "/api/me"],
      ["GET", "/api/me/export"],
      ["GET", "/api/requirements"],
      ["GET", "/api/companies"],
      ["PATCH", "/api/me", { fullName: "Matrix" }],
      ["GET", "/api/submissions/999999/file"],
      ["DELETE", "/api/requirements/999999/submission"],
    ];

    const status = async (who, [method, path, json]) =>
      (await who(method, path, json === undefined ? {} : { json })).status;
    const failures = [];
    const expect = async (rows, expectations) => {
      for (const row of rows) {
        for (const [name, who, want] of expectations) {
          const got = await status(who, row);
          const ok = want === "ok" ? got !== 401 && got !== 403 : got === want;
          if (!ok) failures.push(`${name} ${row[0]} ${row[1]} -> ${got}, wanted ${want}`);
        }
      }
    };
    await expect(staffRead, [
      ["anon", anon, 401],
      ["student", student, 403],
      ["adviser", adviser, 200],
      ["admin", admin, 200],
    ]);
    await expect(staffWrite, [
      ["anon", anon, 401],
      ["student", student, 403],
      ["adviser", adviser, "ok"],
      ["admin", admin, "ok"],
    ]);
    await expect(adminOnly, [
      ["anon", anon, 401],
      ["student", student, 403],
      ["adviser", adviser, 403],
    ]);
    await expect(signedIn, [
      ["anon", anon, 401],
      ["student", student, "ok"],
      ["adviser", adviser, "ok"],
    ]);
    assert.deepEqual(failures, []);
  });
});

describe("privacy and data rights", () => {
  test("consent is required to sign up and is recorded", async () => {
    const c = client();
    const body = { email: "consent@example.com", password: PASSWORD, fullName: "Con Sent" };
    for (const missing of [undefined, false, "yes", 1]) {
      const res = await c("POST", "/api/register", { json: { ...body, acceptPrivacy: missing } });
      assert.equal(res.status, 400, `acceptPrivacy=${missing} must be refused`);
      assert.match(res.body.error, /Privacy Notice/);
    }
    assert.equal((await c("POST", "/api/login", { json: { email: body.email, password: PASSWORD } })).status, 401); // nothing was created
    const ok = await c("POST", "/api/register", { json: { ...body, acceptPrivacy: true } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.privacyAccepted, true);
    const row = (
      await db.execute({
        sql: "SELECT privacy_accepted_at, privacy_version FROM users WHERE email = ?",
        args: [body.email],
      })
    ).rows[0];
    assert.ok(row.privacy_accepted_at && row.privacy_version);
  });

  test("people who signed up before the notice are asked to accept it", async () => {
    const c = await registerAndVerify("legacy@example.com");
    await db.execute({
      sql: "UPDATE users SET privacy_version = NULL, privacy_accepted_at = NULL WHERE email = ?",
      args: ["legacy@example.com"],
    });
    assert.equal((await c("GET", "/api/me")).body.user.privacyAccepted, false);
    assert.equal((await c("POST", "/api/me/privacy", { json: { accept: false } })).status, 400);
    assert.equal((await c("POST", "/api/me/privacy", { json: {} })).status, 400);
    const ok = await c("POST", "/api/me/privacy", { json: { accept: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.privacyAccepted, true);
    assert.equal((await client()("POST", "/api/me/privacy", { json: { accept: true } })).status, 401);
  });

  test("the notice page and its contact details are public", async () => {
    const info = await client()("GET", "/api/privacy-info");
    assert.equal(info.status, 200);
    assert.equal(info.body.contact, "privacy@example.com");
    assert.match(info.body.version, /^\d{4}-\d{2}-\d{2}$/);
    const page = await client()("GET", "/privacy.html");
    assert.equal(page.status, 200);
    const text = Buffer.from(page.body).toString("utf8");
    for (const must of ["Data Privacy Act of 2012", "National Privacy Commission", "Delete my account", "retention"]) {
      assert.ok(text.toLowerCase().includes(must.toLowerCase()), `the notice should mention "${must}"`);
    }
  });

  test("download my data: complete, and never includes the password", async () => {
    const c = await registerAndVerify("export@example.com");
    await c("PATCH", "/api/me", { json: { fullName: "Ex Port", studentId: "2023-5" } });
    await c("POST", "/api/companies", {
      json: {
        name: "Export Co",
        link: "export.example.com",
        email: "hr@export.example.com",
        location: "outside",
        applied: true,
      },
    });
    await c("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("cv bytes")) });

    assert.equal((await client()("GET", "/api/me/export")).status, 401);
    const res = await c("GET", "/api/me/export");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="my-ojt-data-/);
    const data = res.body; // the test client already parsed the JSON
    const raw = JSON.stringify(data);
    assert.deepEqual(
      [data.account.fullName, data.account.studentId, data.account.email],
      ["Ex Port", "2023-5", "export@example.com"],
    );
    assert.ok(data.account.privacyNoticeAcceptedAt);
    assert.deepEqual(
      data.companies.map((x) => [x.name, x.email, x.location, x.applied]),
      [["Export Co", "hr@export.example.com", "Outside Legazpi", true]],
    );
    assert.ok(data.submissions.some((x) => x.requirement === "Resume / CV" && x.fileName === "doc.pdf"));
    assert.ok(!/password|hash|bcrypt|\$2[aby]\$/i.test(raw), "the export must never contain credentials");
  });

  test("delete my account: needs the password, removes everything, leaves others alone", async () => {
    const doomed = await registerAndVerify("doomed@example.com");
    const bystander = await registerAndVerify("bystander@example.com");
    const admin = await adminClient();
    for (const who of [doomed, bystander]) {
      await who("POST", "/api/companies", {
        json: { name: "Some Co", link: "some.example.com", email: "N/A", location: "inside" },
      });
      await who("POST", `/api/requirements/${RESUME}/submit`, { form: upload(pdf("x")) });
    }
    const id = (await doomed("GET", "/api/me")).body.user.id;
    const subId = (await doomed("GET", "/api/requirements")).body.items.find((i) => i.id === RESUME).submission.id;
    await admin("POST", `/api/admin/submissions/${subId}/review`, { json: { status: "approved" } });
    const count = async (table, col = "user_id") =>
      Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, args: [id] })).rows[0].n);

    assert.equal((await client()("DELETE", "/api/me", { json: { password: PASSWORD } })).status, 401);
    assert.equal((await doomed("DELETE", "/api/me", { json: { password: "not my password" } })).status, 400);
    assert.equal((await doomed("DELETE", "/api/me", { json: {} })).status, 400);
    assert.equal((await doomed("GET", "/api/me")).status, 200); // still there

    assert.equal((await doomed("DELETE", "/api/me", { json: { password: PASSWORD } })).status, 200);
    assert.equal((await doomed("GET", "/api/me")).status, 401);
    assert.equal(
      (await client()("POST", "/api/login", { json: { email: "doomed@example.com", password: PASSWORD } })).status,
      401,
    );
    for (const table of ["companies", "submissions", "sessions", "user_tokens"])
      assert.equal(await count(table), 0, `${table} should be empty`);
    assert.equal(await count("users", "id"), 0);
    assert.equal((await bystander("GET", "/api/companies")).body.companies.length, 1); // others untouched
    assert.equal((await bystander("GET", "/api/me")).status, 200);
  });

  test("the only admin cannot delete their own account", async () => {
    const admin = await adminClient();
    const res = await admin("DELETE", "/api/me", { json: { password: PASSWORD } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /only admin/i);
    assert.equal((await admin("GET", "/api/me")).status, 200);
  });

  test("an admin can erase a student on request, but not an admin or themselves", async () => {
    const admin = await adminClient();
    const student = await registerAndVerify("erase-me@example.com");
    const other = await registerAndVerify("second-admin@example.com");
    const adviser = await registerAndVerify("erase-adviser@example.com");
    const studentId = (await student("GET", "/api/me")).body.user.id;
    const otherId = (await other("GET", "/api/me")).body.user.id;
    const adminId = (await admin("GET", "/api/me")).body.user.id;
    await student("POST", "/api/companies", {
      json: { name: "Gone Co", link: "gone.example.com", email: "N/A", location: "inside" },
    });

    assert.equal((await student("DELETE", `/api/admin/users/${studentId}`)).status, 403);
    assert.equal((await adviser("DELETE", `/api/admin/users/${studentId}`)).status, 403);
    assert.equal((await admin("DELETE", `/api/admin/users/${adminId}`)).status, 400); // own account: use Profile
    assert.equal((await admin("DELETE", "/api/admin/users/999999")).status, 404);

    await admin("PATCH", `/api/admin/users/${otherId}/role`, { json: { role: "admin" } });
    assert.equal((await admin("DELETE", `/api/admin/users/${otherId}`)).status, 409); // demote first
    await admin("PATCH", `/api/admin/users/${otherId}/role`, { json: { role: "student" } });

    assert.equal((await admin("DELETE", `/api/admin/users/${studentId}`)).status, 200);
    assert.equal((await student("GET", "/api/me")).status, 401);
    const left = Number(
      (await db.execute({ sql: "SELECT COUNT(*) AS n FROM companies WHERE user_id = ?", args: [studentId] })).rows[0].n,
    );
    assert.equal(left, 0);
  });

  test("no third-party requests: fonts and security policy are first-party only", async () => {
    const c = client();
    const font = await c("GET", "/fonts/geist-latin-wght-normal.woff2");
    assert.equal(font.status, 200);
    const csp = (await c("GET", "/healthz")).headers.get("content-security-policy");
    assert.match(csp, /font-src 'self'(;|$)/);
    assert.ok(
      !/https?:|\*/.test(csp.replace("upgrade-insecure-requests", "")),
      `CSP must not allow other origins: ${csp}`,
    );
  });
});
