// Overview: the adviser's landing tab. Advisers have no checklist of their own, so instead of the student view they get
// the state of the class at a glance and the students who need a nudge. Everything comes from the Tracker endpoint.
import { api, avatar, h, icon } from "/common.js";

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

// Where a student is in the hunt: accepted by a company, applied and waiting for a reply, listed but not applied yet, or
// nothing listed at all.
const stageOf = (s) => {
  const list = s.companyList;
  if (list.some((c) => c.response === "accepted")) return "accepted";
  if (list.some((c) => c.applied)) return "applied";
  return list.length ? "listed" : "none";
};

export async function overviewView(me) {
  const data = await api("GET", "/api/admin/tracker");
  const students = data.students.map((s) => ({ ...s, stage: stageOf(s) }));

  const documents = data.requirements.filter((r) => r.available && !r.optional && r.kind !== "companies");
  const docsWaiting = students.reduce(
    (n, s) => n + documents.filter((r) => s.cells[r.id]?.status === "submitted").length,
    0,
  );
  const count = (stage) => students.filter((s) => s.stage === stage).length;
  const companiesListed = students.reduce((n, s) => n + s.companyList.length, 0);
  const noCompany = students.filter((s) => s.stage === "none");

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
          ? `${plural(students.length, "student")} in your class. ${count("accepted")} accepted by a company, ${noCompany.length} with no company listed yet.`
          : "Students will appear here as soon as they register.",
      ),
    ),
    h(
      "div",
      { className: "ov-hero-actions" },
      h("a", { className: "btn", href: "#tracker" }, icon("table", 16), "Open tracker"),
      h("a", { className: "btn outline on-dark", href: "#review" }, icon("check", 16), "Open review queue"),
    ),
  );

  const stats = h(
    "div",
    { className: "ov-stats" },
    stat("primary", "users", students.length, "Students"),
    stat("primary", "building", companiesListed, "Companies listed"),
    stat(
      "ok",
      "check",
      count("accepted"),
      "Accepted by a company",
      students.length ? `of ${plural(students.length, "student")}` : "",
    ),
    stat("warn", "file", docsWaiting, "Documents to review"),
  );

  const attention = h(
    "section",
    { className: "card" },
    h(
      "div",
      { className: "ov-card-head" },
      h("h2", {}, "No company yet"),
      noCompany.length > 0 && h("a", { href: "#tracker" }, "See all in Tracker"),
    ),
    noCompany.length
      ? h(
          "ul",
          { className: "ov-list" },
          ...noCompany
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
                  h("span", { className: "pill todo" }, "Nothing listed"),
                  icon("chevron", 16),
                ),
              ),
            ),
        )
      : h(
          "div",
          { className: "ov-clear" },
          icon("check", 22),
          h("b", {}, "Everyone has listed a company"),
          h("span", {}, "Every student has at least one company on their list."),
        ),
  );

  const parts = [
    ["ok", "Accepted by a company", count("accepted")],
    ["review", "Applied, waiting for a reply", count("applied")],
    ["listed", "Listed, not applied yet", count("listed")],
    ["none", "Nothing listed yet", count("none")],
  ];
  const progress = h(
    "section",
    { className: "card" },
    h("div", { className: "ov-card-head" }, h("h2", {}, "Company hunt")),
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
