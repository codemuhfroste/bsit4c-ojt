import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

// A malformed vercel.json fails the whole Vercel build ("Invalid vercel.json file provided").
test("vercel.json is valid JSON with the expected rewrite and header rules", () => {
  const config = JSON.parse(fs.readFileSync(new URL("vercel.json", root), "utf8"));
  assert.deepEqual(config.rewrites, [{ source: "/(.*)", destination: "/api" }]);
  assert.ok(fs.existsSync(new URL("api/index.js", root)), "the rewrite target needs api/index.js");

  for (const rule of config.headers) {
    assert.match(rule.source, /^\//);
    const keys = rule.headers.map((h) => h.key);
    assert.ok(keys.includes("Content-Security-Policy") && keys.includes("X-Content-Type-Options"));
  }
});

test("package.json and the environment example are well formed", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(pkg.type, "module");
  const example = fs.readFileSync(new URL(".env.example", root), "utf8");
  for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "APP_URL", "SMTP_URL", "MAIL_FROM", "ADMIN_EMAILS"]) {
    assert.match(example, new RegExp(`^${key}=`, "m"));
  }
});
