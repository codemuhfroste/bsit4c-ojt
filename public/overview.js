// Overview: the adviser's landing tab. Advisers have no checklist of their own, so instead of the student view they get
// the state of the class at a glance and the students who need them next. Everything comes from the Tracker endpoint.
import { api, avatar, h, icon } from "/common.js";
import { companyInfo } from "/tracker.js";

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function stat(tone, glyph, value, label, hint) {
  return h(
    "div",
    { className: `ov-stat ${tone}` },
    h("span", { className: "ov-stat-icon" }, icon(glyph, 20)),
    h("div", {}, h("b", {}, String(value)), h("span", {}, label), hint && h("small", {}, hint)),
  );
}

export async function overviewView(me) {
  const data = await api("GET", "/api/admin/tracker");
  const students = data.students.map((s) => ({ ...s, companies: companyInfo(s.companyList) }));

  const documents = data.requirements.filter((r) => r.available && !r.optional && r.kind !== "companies");
  const docsWaiting = students.reduce(
    (n, s) => n + documents.filter((r) => s.cells[r.id]?.status === "submitted").length,
    0,
  );
  const waiting = students.filter((s) => s.companies.state === "review");
  const companiesWaiting = waiting.reduce((n, s) => n + s.companies.pending.length, 0);
  const count = (state) => students.filter((s) => s.companies.state === state).length;
  const complete = count("ok");

  const first = (me.fullName || me.email).split(/[\s@]/)[0];
  const hero = h(
    "section",
    { className: "card ov-hero" },
    h(
      "div",
      {},
      h("h1", {}, `${greeting()}, ${first}`),
      h(
        "p",
        {},
        students.length
          ? `${plural(students.length, "student")} in your class. ${
              companiesWaiting
                ? `${plural(companiesWaiting, "company", "companies")} are waiting for your review.`
                : "Nothing is waiting for your review."
            }`
          : "Students will appear here as soon as they register.",
      ),
    ),
    h(
      "div",
      { className: "ov-hero-actions" },
      h("a", { className: "btn", href: "#review" }, icon("check", 16), "Open review queue"),
      h("a", { className: "btn outline on-dark", href: "#tracker" }, icon("table", 16), "Open tracker"),
    ),
  );

  const stats = h(
    "div",
    { className: "ov-stats" },
    stat("primary", "users", students.length, "Students"),
    stat(
      "warn",
      "building",
      companiesWaiting,
      "Companies to review",
      waiting.length ? `from ${plural(waiting.length, "student")}` : "",
    ),
    stat("warn", "file", docsWaiting, "Documents to review"),
    stat(
      "ok",
      "check",
      complete,
      "Companies complete",
      students.length ? `of ${plural(students.length, "student")}` : "",
    ),
  );

  const attention = h(
    "section",
    { className: "card" },
    h(
      "div",
      { className: "ov-card-head" },
      h("h2", {}, "Needs your attention"),
      waiting.length > 0 && h("a", { href: "#tracker" }, "See all in Tracker"),
    ),
    waiting.length
      ? h(
          "ul",
          { className: "ov-list" },
          ...[...waiting]
            .sort((a, b) => b.companies.pending.length - a.companies.pending.length)
            .slice(0, 8)
            .map((s) =>
              h(
                "li",
                {},
                h(
                  "a",
                  { className: "ov-row", href: `#students/${s.id}` },
                  avatar(s.fullName, s.email, 38),
                  h(
                    "div",
                    { className: "grow" },
                    h("b", {}, s.fullName || s.email),
                    h("small", {}, s.studentId || s.email),
                  ),
                  h(
                    "span",
                    { className: "pill submitted" },
                    icon("clock", 13),
                    `${s.companies.pending.length} in review`,
                  ),
                  icon("chevron", 16),
                ),
              ),
            ),
        )
      : h(
          "div",
          { className: "ov-clear" },
          icon("check", 22),
          h("b", {}, "You are all caught up"),
          h("span", {}, "No student has companies waiting for review."),
        ),
  );

  const parts = [
    ["ok", "Complete", complete],
    ["review", "In review", count("review")],
    ["changes", "Sent back", count("changes")],
    ["none", "Nothing listed yet", count("none")],
  ];
  const progress = h(
    "section",
    { className: "card" },
    h("div", { className: "ov-card-head" }, h("h2", {}, "Company lists")),
    h(
      "div",
      { className: "ov-bar", role: "img", "aria-label": parts.map(([, label, n]) => `${label}: ${n}`).join(", ") },
      ...parts.map(([key, , n]) => h("i", { className: key, style: `flex:${n}` })),
    ),
    h(
      "ul",
      { className: "ov-legend" },
      ...parts.map(([key, label, n]) =>
        h("li", {}, h("span", { className: `dot ${key}` }), label, h("b", {}, String(n))),
      ),
    ),
  );

  return h("div", { className: "overview" }, hero, stats, h("div", { className: "ov-grid" }, attention, progress));
}
