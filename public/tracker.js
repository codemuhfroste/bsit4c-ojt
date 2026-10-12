// Tracker: a spreadsheet-style grid for advisers and admins. One row per student, one column per requirement, so
// missing work stands out at a glance. Header and student columns stay in view while scrolling.
import { api, avatar, h, icon } from "/common.js";

const RANK = { todo: 0, rejected: 1, submitted: 2, approved: 3 }; // sorting puts the most urgent first
const LABEL = { approved: "Done", submitted: "In review", rejected: "Needs changes", todo: "Missing", na: "N/A" };
const GLYPH = { approved: "check", submitted: "clock", rejected: "alert", todo: "minus", na: "minus" };

// Kept between visits to the tab, so the adviser returns to the view they left.
const state = { q: "", filter: "all", sortKey: "name", dir: 1, showNa: false };

const letters = (index) => {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

const utc = (s) => new Date(`${s.replace(" ", "T")}Z`);
function ago(s) {
  if (!s) return "—";
  const minutes = Math.round((Date.now() - utc(s)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 14 ? `${days} d ago` : utc(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Adds what the grid needs to each student: their status per requirement, what is missing, what awaits review.
function derive(data) {
  const required = data.requirements.filter((r) => r.available && !r.optional);
  const statusFor = (stu, r) => (r.available ? (stu.cells[r.id]?.status ?? "todo") : "na");
  const students = data.students.map((stu) => {
    const missing = required.filter((r) => ["todo", "rejected"].includes(statusFor(stu, r)));
    const pending = required.filter((r) => statusFor(stu, r) === "submitted").length;
    const done = required.filter((r) => statusFor(stu, r) === "approved").length;
    return { ...stu, missing, pending, done, complete: required.length > 0 && done === required.length };
  });
  return { required, statusFor, students };
}

function columnsFor(data) {
  const reqCols = data.requirements
    .filter((r) => r.available || state.showNa)
    .map((req) => ({
      key: `r${req.id}`,
      kind: "req",
      req,
      title: req.title,
      sub: req.optional ? "optional" : req.available ? "" : "N/A for now",
    }));
  return [
    ...reqCols,
    { key: "companies", kind: "num", title: "Companies", get: (s) => s.companies.total, warnZero: true },
    { key: "applied", kind: "num", title: "Applied", get: (s) => s.companies.applied },
    { key: "accepted", kind: "num", title: "Accepted", get: (s) => s.companies.accepted },
    { key: "moa", kind: "num", title: "With MoA", get: (s) => s.companies.moa },
    { key: "reviewed", kind: "num", title: "Companies approved", get: (s) => s.companies.approved },
    { key: "done", kind: "done", title: "Required done" },
    { key: "missing", kind: "missing", title: "Missing" },
    { key: "activity", kind: "time", title: "Last activity" },
  ];
}

function sortValue(col, stu) {
  if (col === "name") return (stu.fullName || stu.email).toLowerCase();
  if (col === "id") return stu.studentId || "";
  if (col === "done") return stu.done;
  if (col === "missing") return stu.missing.length;
  if (col === "activity") return stu.lastActivity || "";
  return null;
}

export async function trackerView() {
  let data = await api("GET", "/api/admin/tracker");
  let updatedAt = new Date();

  const root = h("div", { className: "tracker" });
  const tiles = h("div", { className: "stats four" });
  const toolbar = h("div", { className: "toolbar sheet-tools" });
  const legend = h("div", { className: "legend" });
  const count = h("span", { className: "muted" });
  const stamp = h("span", { className: "muted" });
  const table = h("table", { className: "sheet", role: "grid", "aria-label": "Student requirements tracker" });
  const wrap = h("div", { className: "sheet-wrap", tabindex: "-1" }, table);

  // ---------- rendering ----------

  function visibleRows(info, cols) {
    const q = state.q.trim().toLowerCase();
    const rows = info.students.filter((s) => {
      if (q && ![s.fullName, s.studentId, s.email].some((v) => v?.toLowerCase().includes(q))) return false;
      if (state.filter === "missing") return s.missing.length > 0;
      if (state.filter === "pending") return s.pending > 0;
      if (state.filter === "complete") return s.complete;
      if (state.filter === "unverified") return !s.emailVerified;
      return true;
    });
    const col = cols.find((c) => c.key === state.sortKey);
    const value = (s) => {
      if (state.sortKey === "name" || state.sortKey === "id") return sortValue(state.sortKey, s);
      if (col?.kind === "req") return RANK[info.statusFor(s, col.req)] ?? 9;
      if (col?.kind === "num") return col.get(s);
      return sortValue(state.sortKey, s);
    };
    return rows.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return order * state.dir || (a.fullName || a.email).localeCompare(b.fullName || b.email);
    });
  }

  function sortButton(key, label, sub) {
    const active = state.sortKey === key;
    return h(
      "button",
      {
        type: "button",
        className: "th-btn",
        title: `Sort by ${label}`,
        onclick: () => {
          state.dir = active ? -state.dir : 1;
          state.sortKey = key;
          paint();
        },
      },
      h("span", { className: "th-label" }, label, sub && h("small", {}, sub)),
      active && h("span", { className: "sort-mark", "aria-hidden": "true" }, state.dir === 1 ? "▲" : "▼"),
    );
  }

  function statusCell(info, stu, col, r, c) {
    const status = info.statusFor(stu, col.req);
    const optionalTodo = col.req.optional && status === "todo";
    const label = optionalTodo ? "—" : LABEL[status];
    const td = h(
      "td",
      {
        className: `cell ${optionalTodo ? "optional" : status}`,
        tabindex: "-1",
        "data-r": r,
        "data-c": c,
        title: `${stu.fullName || stu.email} · ${col.title}: ${optionalTodo ? "Not submitted (optional)" : LABEL[status]}`,
        "aria-label": `${stu.fullName || stu.email}, ${col.title}: ${optionalTodo ? "not submitted, optional" : LABEL[status]}`,
      },
      !optionalTodo && icon(GLYPH[status], 13),
      label,
    );
    return td;
  }

  function otherCell(stu, col, r, c, info) {
    const base = { tabindex: "-1", "data-r": r, "data-c": c };
    if (col.kind === "num") {
      const value = col.get(stu);
      return h(
        "td",
        { ...base, className: `cell num${col.warnZero && value === 0 ? " warn" : ""}${value === 0 ? " zero" : ""}` },
        String(value),
      );
    }
    if (col.kind === "done") {
      const total = info.required.length;
      const pct = total ? (stu.done / total) * 100 : 0;
      return h(
        "td",
        { ...base, className: "cell done-cell" },
        h("span", { className: "tabular" }, `${stu.done}/${total}`),
        h("span", { className: "mini" }, h("i", { style: `width:${pct}%` })),
      );
    }
    if (col.kind === "missing") {
      if (!stu.missing.length) {
        return h(
          "td",
          { ...base, className: "cell ok-cell" },
          icon("check", 13),
          stu.pending ? "None (awaiting review)" : "None",
        );
      }
      const names = stu.missing.map((r) => r.title);
      return h(
        "td",
        { ...base, className: "cell missing-cell", title: names.join(", ") },
        h("span", { className: "badge-n" }, String(names.length)),
        h("span", { className: "names" }, names.join(", ")),
      );
    }
    return h("td", { ...base, className: "cell time" }, ago(stu.lastActivity));
  }

  function buildBody(info, cols, rows) {
    const tbody = h("tbody");
    rows.forEach((stu, r) => {
      const tr = h("tr", { "data-student": stu.id });
      tr.append(
        h("td", { className: "rownum" }, String(r + 1)),
        h(
          "td",
          { className: "stu cell", tabindex: "-1", "data-r": r, "data-c": 0 },
          h(
            "div",
            { className: "who" },
            avatar(stu.fullName, stu.email, 28),
            h(
              "div",
              {},
              h("a", { href: `#students/${stu.id}`, className: "name-link" }, h("b", {}, stu.fullName || stu.email)),
              h("small", {}, [stu.studentId, stu.emailVerified ? "" : "unverified"].filter(Boolean).join(" · ")),
            ),
          ),
        ),
      );
      cols.forEach((col, i) =>
        tr.append(col.kind === "req" ? statusCell(info, stu, col, r, i + 1) : otherCell(stu, col, r, i + 1, info)),
      );
      tbody.append(tr);
    });
    return tbody;
  }

  function buildFoot(info, cols, rows) {
    const tr = h(
      "tr",
      {},
      h("td", { className: "rownum" }, "Σ"),
      h("td", { className: "stu totals-label" }, `Totals · ${rows.length} student${rows.length === 1 ? "" : "s"}`),
    );
    for (const col of cols) {
      if (col.kind === "req") {
        const tally = { approved: 0, submitted: 0, missing: 0 };
        for (const s of rows) {
          const st = info.statusFor(s, col.req);
          if (st === "approved") tally.approved++;
          else if (st === "submitted") tally.submitted++;
          else if (st !== "na" && !(col.req.optional && st === "todo")) tally.missing++;
        }
        const total = rows.length || 1;
        tr.append(
          h(
            "td",
            {
              className: "cell total",
              title: `${tally.approved} done · ${tally.submitted} in review · ${tally.missing} missing`,
            },
            h("span", { className: "tabular" }, `${tally.approved}/${rows.length}`),
            h(
              "span",
              { className: "stack" },
              h("i", { className: "a", style: `width:${(tally.approved / total) * 100}%` }),
              h("i", { className: "s", style: `width:${(tally.submitted / total) * 100}%` }),
              h("i", { className: "m", style: `width:${(tally.missing / total) * 100}%` }),
            ),
          ),
        );
      } else if (col.kind === "num") {
        tr.append(h("td", { className: "cell num total" }, String(rows.reduce((sum, s) => sum + col.get(s), 0))));
      } else if (col.kind === "done") {
        tr.append(h("td", { className: "cell total" }, `${rows.filter((s) => s.complete).length} complete`));
      } else if (col.kind === "missing") {
        tr.append(h("td", { className: "cell total" }, `${rows.filter((s) => s.missing.length).length} with missing`));
      } else {
        tr.append(h("td", { className: "cell total" }));
      }
    }
    return h("tfoot", {}, tr);
  }

  function paint() {
    const info = derive(data);
    const cols = columnsFor(data);
    const rows = visibleRows(info, cols);

    // keep the keyboard position through a repaint
    const active = document.activeElement?.closest?.("td[data-r]");
    const keep = active && table.contains(active) ? [active.dataset.r, active.dataset.c] : null;

    const letterRow = h(
      "tr",
      { className: "letters" },
      h("th", { className: "rownum" }, "A"),
      h("th", { className: "stu" }, "B"),
    );
    const titleRow = h(
      "tr",
      { className: "titles" },
      h("th", { className: "rownum", scope: "col" }, "#"),
      h("th", { className: "stu", scope: "col" }, sortButton("name", "Student")),
    );
    cols.forEach((col, i) => {
      letterRow.append(h("th", { scope: "col" }, letters(i + 2)));
      titleRow.append(
        h(
          "th",
          {
            scope: "col",
            "aria-sort": state.sortKey === col.key ? (state.dir === 1 ? "ascending" : "descending") : "none",
            className: col.kind === "req" ? "req-col" : "",
          },
          sortButton(col.key, col.title, col.sub),
        ),
      );
    });
    const body = rows.length
      ? buildBody(info, cols, rows)
      : h(
          "tbody",
          {},
          h(
            "tr",
            {},
            h(
              "td",
              { colSpan: cols.length + 2, className: "sheet-empty" },
              info.students.length ? "No students match these filters." : "No students have registered yet.",
            ),
          ),
        );
    table.replaceChildren(h("thead", {}, letterRow, titleRow), body, buildFoot(info, cols, rows));

    const first = table.querySelector("td[data-r]");
    if (first) first.tabIndex = 0;
    if (keep) table.querySelector(`td[data-r="${keep[0]}"][data-c="${keep[1]}"]`)?.focus({ preventScroll: true });

    count.textContent = `${rows.length} of ${info.students.length} students`;
    stamp.textContent = `Updated ${updatedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    paintTiles(info);
    paintToolbar(info);
  }

  function paintTiles(info) {
    const tile = (label, value, note, cls = "") =>
      h(
        "div",
        { className: `stat ${cls}` },
        h("small", { className: "muted" }, label),
        h("div", { className: "num" }, String(value)),
        note && h("small", { className: "muted" }, note),
      );
    const total = info.students.length;
    tiles.replaceChildren(
      tile("Students", total, `${info.required.length} required task${info.required.length === 1 ? "" : "s"}`),
      tile(
        "All required done",
        info.students.filter((s) => s.complete).length,
        total ? `${Math.round((info.students.filter((s) => s.complete).length / total) * 100)}% of the class` : "",
        "good",
      ),
      tile(
        "Missing required work",
        info.students.filter((s) => s.missing.length).length,
        "need to submit or fix",
        "bad",
      ),
      tile(
        "Waiting for review",
        info.students.filter((s) => s.pending > 0).length,
        "submitted, not reviewed yet",
        "wait",
      ),
    );
  }

  function paintToolbar(info) {
    const chip = (key, text, n) =>
      h(
        "button",
        {
          type: "button",
          className: "chip",
          "aria-pressed": String(state.filter === key),
          onclick: () => {
            state.filter = key;
            paint();
          },
        },
        text,
        h("small", {}, String(n)),
      );
    const all = info.students;
    toolbar.replaceChildren(
      search,
      h(
        "div",
        { className: "chips", role: "group", "aria-label": "Filter students" },
        chip("all", "All", all.length),
        chip("missing", "Has missing work", all.filter((s) => s.missing.length).length),
        chip("pending", "Waiting for review", all.filter((s) => s.pending > 0).length),
        chip("complete", "Complete", all.filter((s) => s.complete).length),
        chip("unverified", "Unverified email", all.filter((s) => !s.emailVerified).length),
      ),
      h(
        "label",
        { className: "check inline" },
        h("input", {
          type: "checkbox",
          checked: state.showNa,
          onchange: (e) => {
            state.showNa = e.target.checked;
            paint();
          },
        }),
        "Show N/A tasks",
      ),
      h("span", { className: "grow" }),
      stamp,
      h(
        "button",
        { type: "button", className: "btn outline sm", onclick: (e) => reload(e.currentTarget) },
        icon("clock", 15),
        "Refresh",
      ),
      h(
        "a",
        { className: "btn outline sm", href: "/api/admin/export/progress.csv", download: "" },
        icon("download", 15),
        "Export CSV",
      ),
    );
  }

  const search = h("input", {
    type: "search",
    placeholder: "Search name, ID or email",
    "aria-label": "Search students",
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value;
      paint();
      search.focus(); // paint() rebuilt the toolbar; keep typing in the box
    },
  });

  async function reload(button) {
    if (button) button.disabled = true;
    try {
      data = await api("GET", "/api/admin/tracker");
      updatedAt = new Date();
      paint();
    } finally {
      if (button) button.disabled = false;
    }
  }

  // ---------- spreadsheet-style keyboard use ----------

  wrap.addEventListener("focusin", (e) => {
    const cell = e.target.closest?.("td[data-r]");
    if (!cell) return;
    for (const old of table.querySelectorAll('td[tabindex="0"]')) old.tabIndex = -1;
    cell.tabIndex = 0;
  });
  wrap.addEventListener("keydown", (e) => {
    const cell = e.target.closest?.("td[data-r]");
    if (!cell) return;
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (move) {
      e.preventDefault();
      table.querySelector(`td[data-r="${r + move[0]}"][data-c="${c + move[1]}"]`)?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const cells = [...table.querySelectorAll(`td[data-r="${r}"][data-c]`)];
      (e.key === "Home" ? cells[0] : cells.at(-1))?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      location.hash = `students/${cell.closest("tr").dataset.student}`;
    }
  });
  wrap.addEventListener("dblclick", (e) => {
    const cell = e.target.closest?.("td[data-r]");
    if (cell) location.hash = `students/${cell.closest("tr").dataset.student}`;
  });
  wrap.addEventListener("click", (e) => {
    const cell = e.target.closest?.("td[data-r]");
    if (cell && !e.target.closest("a")) cell.focus(); // click selects, like a spreadsheet
  });

  legend.append(
    ...["approved", "submitted", "rejected", "todo"].map((s) =>
      h("span", { className: `legend-item ${s}` }, icon(GLYPH[s], 12), LABEL[s]),
    ),
    h("span", { className: "legend-item na" }, "N/A"),
    h(
      "span",
      { className: "muted hint" },
      "Click a cell to select, double-click or press Enter to open the student. Arrow keys move around.",
    ),
  );

  root.append(
    h(
      "div",
      { className: "page-head" },
      h(
        "div",
        {},
        h("h1", {}, "Tracker"),
        h("p", {}, "Every student against every requirement. Red means something is missing."),
      ),
      count,
    ),
    tiles,
    toolbar,
    legend,
    wrap,
  );
  paint();

  // Quietly refresh every minute while this tab is open and visible.
  const timer = setInterval(() => {
    if (!root.isConnected) return clearInterval(timer);
    if (!document.hidden && !wrap.contains(document.activeElement) && document.activeElement !== search)
      reload().catch(() => {});
  }, 60000);

  return root;
}
