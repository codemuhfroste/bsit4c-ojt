import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

// A malformed vercel.json fails the whole Vercel build ("Invalid vercel.json file provided").
test("vercel.json is valid JSON with the expected rewrite and header rules", () => {
  const config = JSON.parse(fs.readFileSync(new URL("vercel.json", root), "utf8"));
  // Without this, Vercel auto-detects Express and tries to run src/app.js (or server.js) as the site's handler.
  assert.equal(config.framework, null);
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

// Vercel's Express auto-detection looks for these file names; they must not exist (see vercel.json "framework").
test("no file names that Vercel treats as an Express entrypoint", () => {
  for (const dir of ["", "src/"]) {
    for (const name of ["app", "index", "server"]) {
      for (const ext of ["js", "mjs", "cjs", "ts"]) {
        assert.equal(
          fs.existsSync(new URL(`${dir}${name}.${ext}`, root)),
          false,
          `${dir}${name}.${ext} would be auto-detected`,
        );
      }
    }
  }
});

test("APP_URL works with or without https:// and a trailing slash", async () => {
  const { appUrl } = await import("../src/mailer.js");
  const check = (value, expected) => {
    if (value === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = value;
    assert.equal(appUrl(), expected);
  };
  check("bsit4c-ojt.vercel.app", "https://bsit4c-ojt.vercel.app");
  check("https://bsit4c-ojt.vercel.app/", "https://bsit4c-ojt.vercel.app");
  check("  http://localhost:3000  ", "http://localhost:3000");
  check("", "http://localhost:3000");
  check(undefined, "http://localhost:3000");
});

test("pages load nothing from other websites (fonts, scripts, styles, images)", () => {
  const dir = new URL("public/", root);
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(html|css|js)$/.test(name)) continue;
    const text = fs.readFileSync(new URL(name, dir), "utf8");
    const patterns = [
      /<(?:link|script|img|iframe|source)\b[^>]*\b(?:src|href)=["']https?:\/\//gi, // embedded resources (links in <a> are fine)
      /@import\s+(?:url\()?["']?https?:\/\//gi,
      /url\(\s*["']?https?:\/\//gi,
    ];
    for (const re of patterns) for (const m of text.matchAll(re)) offenders.push(`${name}: ${m[0].slice(0, 70)}`);
  }
  assert.deepEqual(offenders, []);
});
