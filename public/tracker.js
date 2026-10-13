// Tracker: a grid for advisers and admins. One row per student, one column per required task, then a single Companies
// column: a green check when every company the student listed has been reviewed, or a clock with the companies still
// in review. Hover (or focus) that cell to see the companies by name. The Excel export still lists each company name.
import { api, avatar, h, icon } from "/common.js";

const RANK = { todo: 0, rejected: 1, submitted: 2, approved: 3 }; // sorting puts the most urgent first
const LABEL = { approved: "Done", submitted: "In review", rejected: "Needs changes", todo: "Missing", na: "N/A" };
const GLYPH = { approved: "check", submitted: "clock", rejected: "alert", todo: "minus", na: "minus" };
const CO_LABEL = { accepted: "Accepted", denied: "Denied", applied: "Applied, no reply yet", idle: "Not applied yet" };
const CO_RANK = { none: 0, changes: 1, review: 2, ok: 3 }; // sorting puts the most urgent first
const CO_GLYPH = { ok: "check", review: "clock", changes: "alert", none: "minus" };

// Kept between visits to the tab, so the adviser returns to the view they left.
const state = { q: "", filter: "all", sortKey: "name", dir: 1, showNa: false };

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

// How a company cell is shaded: accepted / denied / applied (waiting) / not applied yet.
const coState = (c) =>
  c.response === "accepted" ? "accepted" : c.response === "denied" ? "denied" : c.applied ? "applied" : "idle";

// Where a student stands on the company list: nothing listed, some still waiting for the adviser, some sent back, or
// every company reviewed.
function companyInfo(list) {
  const pending = list.filter((c) => c.review === "pending");
  const rejected = list.filter((c) => c.review === "rejected");
  const state = !list.length ? "none" : pending.length ? "review" : rejected.length ? "changes" : "ok";
  return { state, pending, rejected, total: list.length };
}

// Adds what the grid needs to each student: status per requirement, what is missing, what awaits review.
function derive(data) {
  const required = data.requirements.filter((r) => r.available && !r.optional);
  const statusFor = (stu, r) => (r.available ? (stu.cells[r.id]?.status ?? "todo") : "na");
  const students = data.students.map((stu) => {
    const missing = required.filter((r) => ["todo", "rejected"].includes(statusFor(stu, r)));
    const pending = required.filter((r) => statusFor(stu, r) === "submitted").length;
    const done = required.filter((r) => statusFor(stu, r) === "approved").length;
    const companies = companyInfo(stu.companyList);
    return { ...stu, missing, pending, done, companies, complete: required.length > 0 && done === required.length };
  });
  return { required, statusFor, students };
}

function columnsFor(data) {
  // Optional tasks (the resume) are left out of the grid, like the CSV.
  const reqCols = data.requirements
    .filter((r) => !r.optional && (r.available || state.showNa))
    .map((req) => ({ key: `r${req.id}`, kind: "req", req, title: req.title, sub: req.available ? "" : "N/A for now" }));
  return [
    ...reqCols,
    { key: "companies", kind: "company", title: "Companies" },
    { key: "done", kind: "done", title: "Required done" },
    { key: "missing", kind: "missing", title: "Missing" },
    { key: "activity", kind: "time", title: "Last activity" },
  ];
}

export async function trackerView() {
  let data = await api("GET", "/api/admin/tracker");
  let updatedAt = new Date();

  const root = h("div", { className: "tracker" });
  const summary = h("p", { className: "tracker-summary" });
  const toolbar = h("div", { className: "sheet-tools" });
  const legend = h("div", { className: "legend" });
  const stamp = h("span", { className: "muted" });
  const table = h("table", { className: "sheet", role: "grid", "aria-label": "Student requirements tracker" });
  const wrap = h("div", { className: "sheet-wrap", tabindex: "-1" }, table);
  const pop = h("div", { className: "pop", role: "presentation", hidden: true }); // each cell's aria-label says it all
  const popFor = new WeakMap(); // Companies cell -> its student

  // ---------- rendering ----------

  function visibleRows(info, cols) {
    const q = state.q.trim().toLowerCase();
    const rows = info.students.filter((s) => {
      if (
        q &&
        ![s.fullName, s.studentId, s.email, ...s.companyList.map((c) => c.name)].some((v) =>
          v?.toLowerCase().includes(q),
        )
      )
        return false;
      if (state.filter === "missing") return s.missing.length > 0;
      if (state.filter === "pending") return s.pending > 0;
      if (state.filter === "complete") return s.complete;
      if (state.filter === "unverified") return !s.emailVerified;
      return true;
    });
    const col = cols.find((c) => c.key === state.sortKey);
    const value = (s) => {
      if (state.sortKey === "name") return (s.fullName || s.email).toLowerCase();
      if (col?.kind === "req") return RANK[info.statusFor(s, col.req)] ?? 9;
      if (col?.kind === "company") return CO_RANK[s.companies.state] * 100 - s.companies.pending.length;
      if (state.sortKey === "done") return s.done;
      if (state.sortKey === "missing") return s.missing.length;
      if (state.sortKey === "activity") return s.lastActivity || "";
      return "";
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

  // The Companies cell is a single glance: a check when every company is reviewed, a clock when some still wait for
  // the adviser, an alert when some were sent back. Hovering or focusing it opens the popover below.
  const sentence = (n) => `${n} compan${n === 1 ? "y" : "ies"}`;

  function companySentence(co) {
    if (co.state === "none") return "no companies listed";
    if (co.state === "ok") return `all ${sentence(co.total)} reviewed`;
    if (co.state === "review") return `${co.pending.length} of ${sentence(co.total)} still in review`;
    return `${co.rejected.length} of ${sentence(co.total)} need changes`;
  }

  // The companies the popover lists: those still in review, those sent back, or (all reviewed) every one.
  const shownFor = (stu) => {
    const co = stu.companies;
    return co.state === "review" ? co.pending : co.state === "changes" ? co.rejected : stu.companyList;
  };

  function companyCell(stu, col, base) {
    const co = stu.companies;
    const who = stu.fullName || stu.email;
    const names = shownFor(stu)
      .map((c) => c.name)
      .join(", ");
    const count = co.state === "ok" ? co.total : shownFor(stu).length;
    const td = h(
      "td",
      {
        ...base,
        className: `cell co-cell ${co.state}`,
        "aria-label": `${who}, ${col.title}: ${companySentence(co)}${names ? `: ${names}` : ""}`,
      },
      co.state === "none"
        ? h("span", { className: "co-none" }, "—")
        : h(
            "span",
            { className: `co-badge ${co.state}` },
            h("i", {}, icon(CO_GLYPH[co.state], 14)),
            h("b", {}, String(count)),
            co.state !== "ok" && h("small", {}, co.state === "review" ? "in review" : "to fix"),
          ),
    );
    if (co.state !== "none") popFor.set(td, stu);
    return td;
  }

  function statusCell(info, stu, col, r, c) {
    const status = info.statusFor(stu, col.req);
    const who = stu.fullName || stu.email;
    return h(
      "td",
      {
        className: `cell st ${status}`,
        tabindex: "-1",
        "data-r": r,
        "data-c": c,
        title: `${who} · ${col.title}: ${LABEL[status]}`,
        "aria-label": `${who}, ${col.title}: ${LABEL[status]}`,
      },
      h("span", { className: `badge ${status}` }, icon(GLYPH[status], 13), LABEL[status]),
    );
  }

  function otherCell(stu, col, r, c, info) {
    const base = { tabindex: "-1", "data-r": r, "data-c": c };
    if (col.kind === "company") return companyCell(stu, col, base);
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
        h(
          "td",
          { className: "stu cell", tabindex: "-1", "data-r": r, "data-c": 0 },
          h(
            "div",
            { className: "who" },
            avatar(stu.fullName, stu.email, 34),
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

  // A tally cell: "3/12" with a green / amber / red bar underneath.
  function tallyCell(ok, wait, bad, total, title) {
    const of = total || 1;
    return h(
      "td",
      { className: "cell total", title },
      h("span", { className: "tabular" }, `${ok}/${total}`),
      h(
        "span",
        { className: "stack" },
        h("i", { className: "a", style: `width:${(ok / of) * 100}%` }),
        h("i", { className: "s", style: `width:${(wait / of) * 100}%` }),
        h("i", { className: "m", style: `width:${(bad / of) * 100}%` }),
      ),
    );
  }

  function buildFoot(info, cols, rows) {
    const tr = h(
      "tr",
      {},
      h("td", { className: "stu totals-label" }, `Class total · ${rows.length} student${rows.length === 1 ? "" : "s"}`),
    );
    for (const col of cols) {
      if (col.kind === "req") {
        const tally = { approved: 0, submitted: 0, missing: 0 };
        for (const s of rows) {
          const st = info.statusFor(s, col.req);
          if (st === "approved") tally.approved++;
          else if (st === "submitted") tally.submitted++;
          else if (st !== "na") tally.missing++;
        }
        tr.append(
          tallyCell(
            tally.approved,
            tally.submitted,
            tally.missing,
            rows.length,
            `${tally.approved} done · ${tally.submitted} in review · ${tally.missing} missing`,
          ),
        );
      } else if (col.kind === "company") {
        const count = (state) => rows.filter((s) => s.companies.state === state).length;
        const [ok, review] = [count("ok"), count("review")];
        const bad = rows.length - ok - review;
        tr.append(
          tallyCell(
            ok,
            review,
            bad,
            rows.length,
            `${ok} all reviewed · ${review} still in review · ${bad} with none listed or needing changes`,
          ),
        );
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

  const sortAria = (key) => (state.sortKey === key ? (state.dir === 1 ? "ascending" : "descending") : "none");

  function paint() {
    hidePop();
    const info = derive(data);
    const cols = columnsFor(data);
    const rows = visibleRows(info, cols);

    // keep the keyboard position through a repaint
    const active = document.activeElement?.closest?.("td[data-r]");
    const keep = active && table.contains(active) ? [active.dataset.r, active.dataset.c] : null;

    const titleRow = h(
      "tr",
      { className: "titles" },
      h("th", { className: "stu", scope: "col", "aria-sort": sortAria("name") }, sortButton("name", "Student")),
    );
    for (const col of cols) {
      titleRow.append(
        h(
          "th",
          { scope: "col", "aria-sort": sortAria(col.key), className: col.kind === "req" ? "req-col" : "" },
          sortButton(col.key, col.title, col.sub),
        ),
      );
    }
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
              { colSpan: cols.length + 1, className: "sheet-empty" },
              h("strong", {}, info.students.length ? "No students match these filters" : "No students yet"),
              h(
                "span",
                {},
                info.students.length
                  ? "Try a different search or pick another filter."
                  : "Students show up here as soon as they register.",
              ),
            ),
          ),
        );
    table.replaceChildren(h("thead", {}, titleRow), body, buildFoot(info, cols, rows));

    const first = table.querySelector("td[data-r]");
    if (first) first.tabIndex = 0;
    if (keep) table.querySelector(`td[data-r="${keep[0]}"][data-c="${keep[1]}"]`)?.focus({ preventScroll: true });

    stamp.textContent = `Updated ${updatedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    const all = info.students;
    summary.textContent = `${rows.length === all.length ? all.length : `${rows.length} of ${all.length}`} students · ${all.filter((s) => s.complete).length} complete · ${all.filter((s) => s.missing.length).length} missing required work · ${all.filter((s) => s.pending > 0).length} waiting for review`;
    paintToolbar(info);
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
      h("label", { className: "search" }, icon("search", 16), search),
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
    );
  }

  const search = h("input", {
    type: "search",
    placeholder: "Search student, ID, email or company",
    "aria-label": "Search students or companies",
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

  // ---------- company popover ----------
  // One floating panel shared by every Companies cell. It is `position: fixed`, so the scrolling grid cannot clip it.

  const PLACE = { inside: "Inside Legazpi", outside: "Outside Legazpi" };
  const POP_MAX = 8;

  function showPop(cell) {
    const stu = popFor.get(cell);
    if (!stu) return hidePop();
    const co = stu.companies;
    const shown = shownFor(stu);
    const title =
      co.state === "ok"
        ? `All ${sentence(co.total)} reviewed`
        : co.state === "review"
          ? `${co.pending.length} still in review`
          : `${co.rejected.length} sent back for changes`;

    pop.className = `pop ${co.state}`;
    pop.replaceChildren(
      ...[
        h(
          "div",
          { className: "pop-head" },
          h("span", { className: `co-badge ${co.state}` }, h("i", {}, icon(CO_GLYPH[co.state], 14))),
          h("div", {}, h("b", {}, title), h("small", {}, stu.fullName || stu.email)),
        ),
        h(
          "ul",
          {},
          ...shown.slice(0, POP_MAX).map((c) => {
            const shade = coState(c);
            return h(
              "li",
              {},
              h("b", {}, c.name),
              h(
                "span",
                { className: "pop-meta" },
                h("span", { className: `dot ${shade}` }),
                CO_LABEL[shade],
                h("span", { className: "sep" }, "·"),
                PLACE[c.location] ?? c.location,
                c.moa && h("span", { className: "pop-moa" }, icon("shield", 11), "MoA"),
              ),
            );
          }),
        ),
        shown.length > POP_MAX && h("p", { className: "pop-foot" }, `+ ${shown.length - POP_MAX} more`),
        co.state !== "ok" &&
          co.total > shown.length &&
          h("p", { className: "pop-foot" }, `${co.total - shown.length} more already reviewed`),
      ].filter(Boolean), // replaceChildren (unlike h) would print a literal "false"
    );

    pop.hidden = false;
    const r = cell.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + box.height > innerHeight - 8) top = Math.max(8, r.top - box.height - 6);
    const left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - box.width - 8));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  function hidePop() {
    pop.hidden = true;
  }

  // ---------- spreadsheet-style keyboard use ----------

  wrap.addEventListener("pointerover", (e) => {
    const cell = e.target.closest?.("td.co-cell");
    if (cell) showPop(cell);
  });
  wrap.addEventListener("pointerout", (e) => {
    const cell = e.target.closest?.("td.co-cell");
    if (cell && !cell.contains(e.relatedTarget)) hidePop();
  });
  wrap.addEventListener("scroll", hidePop, { passive: true });
  wrap.addEventListener("focusin", (e) => {
    const cell = e.target.closest?.("td[data-r]");
    if (!cell) return;
    for (const old of table.querySelectorAll('td[tabindex="0"]')) old.tabIndex = -1;
    cell.tabIndex = 0;
    if (cell.classList.contains("co-cell")) showPop(cell);
    else hidePop();
  });
  wrap.addEventListener("focusout", hidePop);
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return hidePop();
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

  const refresh = h(
    "button",
    { type: "button", className: "btn outline sm", onclick: (e) => reload(e.currentTarget) },
    icon("clock", 15),
    "Refresh",
  );
  const exportLink = h(
    "a",
    {
      className: "btn outline sm",
      href: "/api/admin/export/progress.csv",
      download: "",
      title: "One row per student, with every company name, ready for Excel",
    },
    icon("download", 15),
    "Export to Excel (CSV)",
  );

  legend.append(
    ...["approved", "submitted", "rejected", "todo"].map((s) =>
      h("span", { className: `legend-item ${s}` }, icon(GLYPH[s], 12), LABEL[s]),
    ),
    h("span", { className: "legend-sep" }),
    h("span", { className: "legend-item co-ok" }, icon("check", 12), "Companies reviewed"),
    h("span", { className: "legend-item co-review" }, icon("clock", 12), "Companies in review"),
    h("span", { className: "legend-item co-changes" }, icon("alert", 12), "Companies sent back"),
    h("span", { className: "muted hint" }, "Hover a Companies cell for the names · Enter opens a student"),
  );

  root.append(
    h(
      "div",
      { className: "tracker-head" },
      h("div", {}, h("h1", {}, "Tracker"), summary),
      h("div", { className: "tracker-actions" }, stamp, refresh, exportLink),
    ),
    toolbar,
    legend,
    wrap,
    pop,
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
