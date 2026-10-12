import { api, avatar, fmtDate, fmtDay, h, icon, openDialog, parseDay, toast } from "/common.js";

const view = document.getElementById("view");

// append / replaceChildren that skip false/null (so `cond && element` works like it does in h()).
const put = (el, ...kids) => el.append(...kids.filter(Boolean));
const fill = (el, ...kids) => el.replaceChildren(...kids.filter(Boolean));
const MAX_BYTES = 4 * 1024 * 1024;
const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg"];

let me;
const isStaff = () => me.role === "adviser" || me.role === "admin";
const isAdmin = () => me.role === "admin";
const ROLE_LABEL = { student: "Student", adviser: "Adviser", admin: "Administrator" };

const STATUS = {
  todo: { label: "To do", icon: "file" },
  submitted: { label: "In review", icon: "clock" },
  rejected: { label: "Needs changes", icon: "alert" },
  approved: { label: "Approved", icon: "check" },
};
const statusOf = (item) => item.submission?.status ?? "todo";
const pill = (status, small = true) =>
  h("span", { className: `pill ${status}` }, icon(STATUS[status].icon, small ? 13 : 15), STATUS[status].label);
const sizeText = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

// Disables the button while fn runs and reports failures as a toast.
async function run(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) return (location.href = "/");
    toast(err.message, "err");
  } finally {
    if (button) button.disabled = false;
  }
}

function confirmDialog({ title, text, confirm = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const dialog = openDialog((close) =>
      h(
        "form",
        {
          method: "dialog",
          onsubmit: (e) => {
            e.preventDefault();
            resolve(true);
            close();
          },
        },
        h("h2", {}, title),
        h("p", { className: "muted", style: "margin-bottom:16px" }, text),
        h(
          "div",
          { className: "actions" },
          h("button", { type: "button", className: "btn outline", onclick: close }, "Cancel"),
          h("button", { type: "submit", className: `btn ${danger ? "danger" : ""}` }, confirm),
        ),
      ),
    );
    dialog.addEventListener("close", () => resolve(false));
  });
}

const empty = (title, text) =>
  h(
    "div",
    { className: "empty" },
    h(
      "span",
      { className: "avatar", style: "--size:64px;background:var(--primary-soft);color:var(--primary-ink)" },
      icon("inbox", 28),
    ),
    h("strong", {}, title),
    h("p", {}, text),
  );

const pageHead = (title, subtitle, ...actions) =>
  h(
    "div",
    { className: "page-head" },
    h("div", {}, h("h1", {}, title), subtitle && h("p", {}, subtitle)),
    h("div", { className: "actions" }, ...actions),
  );

// ---------- Progress ring ----------

function ring(pct) {
  const NS = "http://www.w3.org/2000/svg";
  const C = 2 * Math.PI * 44;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 104 104");
  svg.setAttribute("aria-hidden", "true");
  const make = (cls) => {
    const c = document.createElementNS(NS, "circle");
    for (const [k, v] of Object.entries({
      cx: 52,
      cy: 52,
      r: 44,
      fill: "none",
      "stroke-width": 10,
      "stroke-linecap": "round",
      class: cls,
    })) {
      c.setAttribute(k, v);
    }
    return c;
  };
  const bar = make("bar");
  bar.setAttribute("stroke-dasharray", `0 ${C}`);
  svg.append(make("track"), bar);
  if (!pct) bar.setAttribute("stroke-opacity", "0"); // no stray dot at 0%
  requestAnimationFrame(() =>
    requestAnimationFrame(() => bar.setAttribute("stroke-dasharray", `${(C * pct) / 100} ${C}`)),
  );
  return h("div", { className: "ring", role: "img", "aria-label": `${pct}% complete` }, svg, h("b", {}, `${pct}%`));
}

// ======================================================================
// Checklist
// ======================================================================

let filter = "all";

function groupByPhase(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.phase)) map.set(item.phase, []);
    map.get(item.phase).push(item);
  }
  return [...map].map(([name, list]) => ({ name, items: list }));
}

function scrollToItem(id) {
  const row = document.getElementById(`req-${id}`);
  if (!row) return;
  const phase = row.closest("details");
  if (phase) phase.open = true;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1400);
}

function dueChip(item, status) {
  if (!item.dueDate) return null;
  const days = Math.ceil((parseDay(item.dueDate) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const open = status === "todo" || status === "rejected";
  if (open && days < 0)
    return h("span", { className: "pill err" }, icon("calendar", 13), `Overdue · ${fmtDay(item.dueDate)}`);
  if (open && days <= 7) {
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    return h("span", { className: "pill warn" }, icon("calendar", 13), `Due ${when}`);
  }
  return h("span", { className: "pill" }, icon("calendar", 13), `Due ${fmtDay(item.dueDate)}`);
}

function uploadPanel(item, close) {
  let picked = null;
  const input = h("input", { type: "file", accept: FILE_TYPES.join(",") });
  const title = h("span", { className: "picked" }, "Drop a file here, or click to browse");
  const hint = h("span", {}, "PDF, PNG or JPG · up to 4 MB");
  const send = h("button", { type: "button", className: "btn sm", disabled: true }, icon("upload", 15), "Upload");
  const zone = h("label", { className: "dropzone" }, icon("upload", 26), title, hint, input);

  function pick(file) {
    if (!file) return;
    if (!FILE_TYPES.includes(file.type)) return toast("Only PDF, PNG or JPEG files are allowed.", "err");
    if (file.size > MAX_BYTES) return toast("That file is over 4 MB.", "err");
    picked = file;
    title.textContent = file.name;
    hint.textContent = sizeText(file.size);
    send.disabled = false;
  }

  input.addEventListener("change", () => pick(input.files[0]));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    pick(e.dataTransfer.files[0]);
  });
  send.addEventListener("click", () =>
    run(send, async () => {
      const form = new FormData();
      form.append("file", picked);
      await api("POST", `/api/requirements/${item.id}/submit`, form);
      toast("Submitted for review.");
      await render();
    }),
  );

  return h(
    "div",
    { className: "panel" },
    zone,
    h(
      "div",
      { className: "actions" },
      h("button", { type: "button", className: "btn outline sm", onclick: close }, "Cancel"),
      send,
    ),
  );
}

function activity(item) {
  const status = statusOf(item);
  const sub = item.submission;
  const locked = status === "approved";
  const blocked = !me.emailVerified;
  const li = h("li", { className: "activity", id: `req-${item.id}`, "data-status": status });
  let panel = null;

  const togglePanel = () => {
    if (panel) {
      panel.remove();
      panel = null;
    } else {
      panel = uploadPanel(item, togglePanel);
      li.append(panel);
    }
  };

  const meta = h(
    "div",
    { className: "meta" },
    dueChip(item, status),
    item.requiresFile
      ? h("span", { className: "pill" }, icon("file", 13), "PDF, PNG or JPG")
      : h("span", { className: "pill" }, icon("check", 13), "No file needed"),
    sub?.fileName && h("a", { href: `/api/submissions/${sub.id}/file` }, icon("download", 14), sub.fileName),
    sub && h("span", { className: "muted" }, `Updated ${fmtDate(sub.updatedAt)}`),
  );

  const side = h("div", { className: "act-side" });
  const lockTitle = blocked ? "Verify your email to submit" : undefined;

  if (locked) {
    put(side, h("span", { className: "btn ok sm done-btn", style: "pointer-events:none" }, icon("check", 15), "Done"));
  } else if (status === "submitted") {
    put(
      side,
      pill("submitted", false),
      h(
        "div",
        { className: "act-links" },
        item.requiresFile &&
          h(
            "button",
            { type: "button", className: "btn link", disabled: blocked, onclick: togglePanel },
            "Replace file",
          ),
        h(
          "button",
          {
            type: "button",
            className: "btn link",
            disabled: blocked,
            onclick: (e) =>
              run(e.currentTarget, async () => {
                await api("DELETE", `/api/requirements/${item.id}/submission`);
                toast("Submission withdrawn.");
                await render();
              }),
          },
          "Withdraw",
        ),
      ),
    );
  } else {
    const label = status === "rejected" ? "Re-submit" : item.requiresFile ? "Submit" : "Mark as done";
    put(
      side,
      status === "rejected" && pill("rejected", false),
      h(
        "button",
        {
          type: "button",
          className: "btn sm done-btn",
          disabled: blocked,
          title: lockTitle,
          onclick: (e) => {
            if (item.requiresFile) return togglePanel();
            run(e.currentTarget, async () => {
              await api("POST", `/api/requirements/${item.id}/submit`, new FormData());
              toast("Marked as done. Waiting for review.");
              await render();
            });
          },
        },
        icon(item.requiresFile ? "upload" : "check", 15),
        label,
      ),
    );
  }

  li.append(
    h("div", { className: "act-icon" }, icon(item.requiresFile ? "file" : "check", 22)),
    h(
      "div",
      { className: "act-body" },
      h("h3", {}, item.title),
      item.description && h("p", { className: "desc" }, item.description),
      meta,
      sub?.note && h("div", { className: `callout ${status}` }, h("b", {}, "Reviewer: "), sub.note),
    ),
    side,
  );
  return li;
}

function pathAside(phases) {
  const aside = h("aside", { className: "card path", "aria-label": "Your path" }, h("h2", {}, "Your path"));
  for (const phase of phases) {
    aside.append(
      h("p", { className: "phase-label" }, phase.name),
      h(
        "ul",
        { className: "steps" },
        ...phase.items.map((item) => {
          const status = statusOf(item);
          const glyph = { approved: "check", submitted: "clock", rejected: "x", todo: "check" }[status];
          return h(
            "li",
            { className: "step" },
            h("span", { className: `node ${status}` }, icon(glyph, 11)),
            h("button", { type: "button", onclick: () => scrollToItem(item.id) }, item.title),
          );
        }),
      ),
    );
  }
  return aside;
}

async function checklistView() {
  const { items, progress } = await api("GET", "/api/requirements");
  const count = (s) => items.filter((i) => statusOf(i) === s).length;
  const pct = progress.total ? Math.round((progress.approved / progress.total) * 100) : 0;
  const next = items.find((i) => ["todo", "rejected"].includes(statusOf(i)));
  const phases = groupByPhase(items);

  const summary = h(
    "section",
    { className: "card summary" },
    ring(pct),
    h(
      "div",
      {},
      h(
        "h2",
        {},
        pct === 100
          ? "All requirements approved!"
          : `${me.fullName ? `${me.fullName.split(" ")[0]}, your` : "Your"} OJT progress`,
      ),
      h("p", {}, `${progress.approved} of ${progress.total} requirements approved`),
      h(
        "div",
        { className: "stat-chips" },
        h("span", {}, h("b", {}, count("submitted")), " in review"),
        h("span", {}, h("b", {}, count("rejected")), " need changes"),
        h("span", {}, h("b", {}, count("todo")), " to do"),
      ),
      next &&
        h(
          "p",
          { className: "nextup" },
          "Next up: ",
          h("button", { type: "button", onclick: () => scrollToItem(next.id) }, next.title),
        ),
    ),
  );

  const chips = h(
    "div",
    { className: "chips", role: "group", "aria-label": "Filter requirements" },
    ...[
      ["all", "All", items.length],
      ["todo", "To do", count("todo")],
      ["submitted", "In review", count("submitted")],
      ["rejected", "Needs changes", count("rejected")],
      ["approved", "Approved", count("approved")],
    ].map(([key, text, n]) =>
      h(
        "button",
        {
          type: "button",
          className: "chip",
          "aria-pressed": String(filter === key),
          onclick: () => {
            filter = key;
            render();
          },
        },
        text,
        h("small", {}, n),
      ),
    ),
  );

  const sections = phases
    .map((phase) => {
      const shown = phase.items.filter((i) => filter === "all" || statusOf(i) === filter);
      if (!shown.length) return null;
      const done = phase.items.filter((i) => statusOf(i) === "approved").length;
      return h(
        "details",
        { className: "card phase", open: true },
        h(
          "summary",
          {},
          h(
            "div",
            { className: "phase-title" },
            h("h2", {}, phase.name),
            h("small", { className: "muted" }, `${done} of ${phase.items.length} approved`),
          ),
          h(
            "div",
            { className: "meter", style: "margin-left:auto" },
            h("i", { style: `width:${(done / phase.items.length) * 100}%` }),
          ),
          h("span", { className: "chev", style: "margin-left:12px" }, icon("chevron", 18)),
        ),
        h("ul", { className: "activities" }, ...shown.map(activity)),
      );
    })
    .filter(Boolean);

  return h(
    "div",
    {},
    !me.emailVerified && verifyBanner(),
    h(
      "div",
      { className: "checklist-layout" },
      pathAside(phases),
      h(
        "div",
        {},
        summary,
        chips,
        ...(sections.length
          ? sections
          : [h("div", { className: "card" }, empty("Nothing here", "No requirements match this filter."))]),
      ),
    ),
  );
}

function verifyBanner() {
  const btn = h(
    "button",
    {
      type: "button",
      className: "btn link",
      onclick: () =>
        run(btn, async () => {
          await api("POST", "/api/verify/resend");
          toast("Verification email sent.");
        }),
    },
    "Resend email",
  );
  return h(
    "div",
    { className: "banner" },
    icon("mail", 18),
    h("span", {}, "Verify your email to submit requirements. Check your inbox for the link."),
    btn,
  );
}

// ======================================================================
// Profile (modeled on the RCMS member profile)
// ======================================================================

const HISTORY_PAGE = 6;

function editProfileDialog() {
  openDialog((close) => {
    const form = h(
      "form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(form));
          run(form.querySelector("[type=submit]"), async () => {
            me = (await api("PATCH", "/api/me", data)).user;
            close();
            toast("Profile saved.");
            await render();
          });
        },
      },
      h("h2", {}, "Edit profile"),
      h(
        "label",
        { className: "field" },
        "Full name",
        h("input", { name: "fullName", value: me.fullName, maxLength: 100, autocomplete: "name" }),
      ),
      h(
        "label",
        { className: "field" },
        "Student ID",
        h("input", { name: "studentId", value: me.studentId, maxLength: 30 }),
      ),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", className: "btn outline", onclick: close }, "Cancel"),
        h("button", { type: "submit", className: "btn" }, "Save changes"),
      ),
    );
    return form;
  });
}

function passwordDialog() {
  openDialog((close) => {
    const form = h(
      "form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(form));
          run(form.querySelector("[type=submit]"), async () => {
            await api("POST", "/api/me/password", data);
            close();
            toast("Password changed. Other devices were signed out.");
          });
        },
      },
      h("h2", {}, "Change password"),
      h(
        "label",
        { className: "field" },
        "Current password",
        h("input", { name: "currentPassword", type: "password", autocomplete: "current-password", required: true }),
      ),
      h(
        "label",
        { className: "field" },
        "New password",
        h("input", {
          name: "newPassword",
          type: "password",
          autocomplete: "new-password",
          minLength: 8,
          maxLength: 72,
          required: true,
        }),
      ),
      h(
        "p",
        { className: "muted", style: "margin:-6px 0 14px;font-size:.82rem" },
        "At least 8 characters. Other devices will be signed out.",
      ),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", className: "btn outline", onclick: close }, "Cancel"),
        h("button", { type: "submit", className: "btn" }, "Change password"),
      ),
    );
    return form;
  });
}

async function profileView() {
  const { items, progress } = await api("GET", "/api/requirements");
  const submitted = items
    .filter((i) => i.submission)
    .sort((a, b) => b.submission.updatedAt.localeCompare(a.submission.updatedAt));
  const inReview = items.filter((i) => statusOf(i) === "submitted").length;
  const remaining = progress.total - progress.approved;
  const overall =
    remaining === 0 && progress.total > 0
      ? ["ok", "Complete"]
      : progress.approved > 0 || inReview > 0
        ? ["warn", "In progress"]
        : ["err", "Not started"];

  const info = (iconName, label, value) =>
    h("div", {}, h("dt", {}, icon(iconName, 14), label), h("dd", {}, value || "—"));

  const identity = h(
    "section",
    { className: "card" },
    h(
      "div",
      { className: "profile-top" },
      h(
        "div",
        { className: "profile-id" },
        avatar(me.fullName, me.email, 72),
        h(
          "div",
          {},
          h("h1", {}, me.fullName || me.email),
          h(
            "div",
            { className: "line" },
            h("span", {}, me.joined ? `Joined ${fmtDate(me.joined)}` : "Join date unknown"),
            h("span", { className: "pill solid" }, ROLE_LABEL[me.role]),
            me.emailVerified
              ? h("span", { className: "pill approved" }, icon("check", 13), "Verified")
              : h("span", { className: "pill submitted" }, icon("alert", 13), "Not verified"),
          ),
          h("p", { className: "muted", style: "margin-top:6px;font-size:.9rem" }, "BSIT 4C · On-the-Job Training"),
        ),
      ),
      h(
        "div",
        { className: "profile-actions" },
        h(
          "button",
          { type: "button", className: "btn outline sm", onclick: editProfileDialog },
          icon("pencil", 15),
          "Edit profile",
        ),
        h(
          "button",
          { type: "button", className: "btn outline sm", onclick: passwordDialog },
          icon("key", 15),
          "Change password",
        ),
      ),
    ),
    h(
      "dl",
      { className: "info-grid" },
      info("id", "Student ID", me.studentId),
      info("mail", "Email", me.email),
      info("list", "Course", "BSIT 4C"),
    ),
  );

  const stats = h(
    "div",
    { className: "stats" },
    h(
      "div",
      { className: "stat" },
      h("small", { className: "muted" }, "Approved"),
      h("div", { className: "num" }, `${progress.approved}/${progress.total}`),
    ),
    h(
      "div",
      { className: "stat" },
      h("small", { className: "muted" }, "In review"),
      h("div", { className: "num" }, inReview),
    ),
    h(
      "div",
      { className: "stat" },
      h("small", { className: "muted" }, "Remaining"),
      h("div", { className: "num" }, remaining, h("span", { className: `pill ${overall[0]}` }, overall[1])),
    ),
  );

  // Submission history, paged like the RCMS payment history.
  let page = 1;
  const historyCard = h("div", { className: "card table-card" });
  const paintHistory = () => {
    const pages = Math.max(1, Math.ceil(submitted.length / HISTORY_PAGE));
    page = Math.min(page, pages);
    const rows = submitted.slice((page - 1) * HISTORY_PAGE, page * HISTORY_PAGE);
    if (!submitted.length)
      return fill(historyCard, empty("No submissions yet", "Requirements you submit will show up here."));
    const prev = h(
      "button",
      {
        type: "button",
        className: "btn outline sm",
        disabled: page === 1,
        onclick: () => {
          page--;
          paintHistory();
        },
      },
      "← Prev",
    );
    const next = h(
      "button",
      {
        type: "button",
        className: "btn outline sm",
        disabled: page === pages,
        onclick: () => {
          page++;
          paintHistory();
        },
      },
      "Next →",
    );
    fill(
      historyCard,
      h(
        "div",
        { className: "scroll" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ...["Requirement", "File", "Updated", "Status"].map((t) => h("th", {}, t)))),
          h(
            "tbody",
            {},
            ...rows.map((i) =>
              h(
                "tr",
                {},
                h("td", {}, h("b", {}, i.title), i.phase && h("small", { style: "display:block" }, i.phase)),
                h(
                  "td",
                  {},
                  i.submission.fileName
                    ? h("a", { href: `/api/submissions/${i.submission.id}/file` }, i.submission.fileName)
                    : "—",
                ),
                h("td", {}, fmtDate(i.submission.updatedAt)),
                h(
                  "td",
                  {},
                  pill(statusOf(i)),
                  i.submission.note && h("small", { style: "display:block;margin-top:4px" }, i.submission.note),
                ),
              ),
            ),
          ),
        ),
      ),
      pages > 1 &&
        h(
          "div",
          { className: "pager" },
          h(
            "span",
            {},
            `Showing ${(page - 1) * HISTORY_PAGE + 1}–${Math.min(page * HISTORY_PAGE, submitted.length)} of ${submitted.length}`,
          ),
          h("div", {}, prev, h("span", {}, `Page ${page} of ${pages}`), next),
        ),
    );
  };
  paintHistory();

  return h(
    "div",
    { className: "profile-wrap" },
    !me.emailVerified && verifyBanner(),
    identity,
    stats,
    h("div", { className: "section-head" }, h("h2", {}, "Submission history")),
    historyCard,
  );
}

// ======================================================================
// Review queue (staff)
// ======================================================================

let reviewFilter = "submitted";

async function reviewView() {
  const { submissions } = await api("GET", `/api/admin/submissions${reviewFilter ? `?status=${reviewFilter}` : ""}`);
  const chips = h(
    "div",
    { className: "chips", role: "group", "aria-label": "Filter submissions" },
    ...[
      ["submitted", "Needs review"],
      ["rejected", "Rejected"],
      ["approved", "Approved"],
      ["", "All"],
    ].map(([key, text]) =>
      h(
        "button",
        {
          type: "button",
          className: "chip",
          "aria-pressed": String(reviewFilter === key),
          onclick: () => {
            reviewFilter = key;
            render();
          },
        },
        text,
      ),
    ),
  );

  const list = h("div", { className: "list" });
  if (!submissions.length)
    list.append(h("div", { className: "card" }, empty("All caught up", "There is nothing in this view.")));

  for (const s of submissions) {
    const note = h("input", {
      type: "text",
      maxLength: 500,
      placeholder: "Note for the student (required to reject)",
      "aria-label": "Reviewer note",
      value: s.note,
    });
    const decide = (status) => (e) =>
      run(e.currentTarget, async () => {
        await api("POST", `/api/admin/submissions/${s.id}/review`, { status, note: note.value });
        toast(status === "approved" ? "Approved." : "Sent back for changes.");
        await render();
      });
    list.append(
      h(
        "article",
        { className: "card review-card" },
        h(
          "div",
          {},
          h(
            "div",
            { className: "top" },
            avatar(s.fullName, s.email, 40),
            h(
              "div",
              {},
              h("b", {}, s.fullName || s.email),
              h("small", { style: "display:block" }, [s.studentId, s.email].filter(Boolean).join(" · ")),
            ),
          ),
          h(
            "div",
            { className: "meta", style: "margin-top:12px" },
            h("b", { style: "font-size:.95rem;margin-right:4px" }, s.requirement),
            pill(s.status),
            s.fileName && h("a", { href: `/api/submissions/${s.id}/file` }, icon("download", 14), s.fileName),
            h("span", { className: "muted" }, fmtDate(s.updatedAt)),
          ),
        ),
        h(
          "div",
          { className: "decide" },
          note,
          h(
            "div",
            { className: "buttons" },
            h(
              "button",
              { type: "button", className: "btn ok sm", onclick: decide("approved") },
              icon("check", 15),
              "Approve",
            ),
            h(
              "button",
              { type: "button", className: "btn danger sm", onclick: decide("rejected") },
              icon("x", 15),
              "Reject",
            ),
          ),
        ),
      ),
    );
  }
  return h("div", {}, pageHead("Review submissions", "Approve documents or send them back with a note."), chips, list);
}

// ======================================================================
// Students (staff; admins can change roles)
// ======================================================================

async function studentsView() {
  const { users, totalRequirements } = await api("GET", "/api/admin/users");
  const search = h("input", {
    type: "search",
    placeholder: "Search by name, email or ID",
    "aria-label": "Search students",
  });
  const body = h("tbody");
  const card = h("div", { className: "card table-card" });

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const rows = users.filter(
      (u) => !q || [u.fullName, u.email, u.studentId].some((v) => v?.toLowerCase().includes(q)),
    );
    if (!rows.length) return card.replaceChildren(empty("No matches", "Try a different search."));
    body.replaceChildren(
      ...rows.map((u) => {
        const roleCell =
          isAdmin() && u.id !== me.id
            ? h(
                "select",
                {
                  "aria-label": `Role for ${u.email}`,
                  style: "width:auto;padding:6px 10px",
                  onchange: (e) =>
                    run(e.target, async () => {
                      await api("PATCH", `/api/admin/users/${u.id}/role`, { role: e.target.value });
                      toast(`${u.fullName || u.email} is now ${ROLE_LABEL[e.target.value].toLowerCase()}.`);
                    }),
                },
                ...["student", "adviser", "admin"].map((r) =>
                  h("option", { value: r, selected: r === u.role }, ROLE_LABEL[r]),
                ),
              )
            : h("span", { className: `pill ${u.role === "student" ? "" : "solid"}` }, ROLE_LABEL[u.role]);
        const pct = totalRequirements ? (u.approved / totalRequirements) * 100 : 0;
        return h(
          "tr",
          {},
          h(
            "td",
            {},
            h(
              "div",
              { className: "who" },
              avatar(u.fullName, u.email, 36),
              h(
                "div",
                {},
                h("b", {}, u.fullName || "—"),
                h("small", {}, u.email, u.emailVerified ? "" : " · unverified"),
              ),
            ),
          ),
          h("td", {}, u.studentId || "—"),
          h(
            "td",
            { style: "min-width:170px" },
            h(
              "div",
              { style: "display:flex;align-items:center;gap:10px" },
              h("div", { className: "meter", style: "flex:1" }, h("i", { style: `width:${pct}%` })),
              h(
                "span",
                { className: "muted", style: "font-variant-numeric:tabular-nums" },
                `${u.approved}/${totalRequirements}`,
              ),
            ),
            u.submitted - u.approved > 0 && h("small", {}, `${u.submitted - u.approved} awaiting action`),
          ),
          h("td", {}, roleCell),
        );
      }),
    );
    card.replaceChildren(
      h(
        "div",
        { className: "scroll" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ...["Student", "Student ID", "Progress", "Role"].map((t) => h("th", {}, t)))),
          body,
        ),
      ),
    );
  };
  search.addEventListener("input", paint);
  paint();

  return h(
    "div",
    {},
    pageHead("Students", `${users.length} account${users.length === 1 ? "" : "s"} · ${totalRequirements} requirements`),
    h("div", { className: "toolbar" }, search),
    card,
  );
}

// ======================================================================
// Requirements (admin)
// ======================================================================

function requirementDialog(item, items) {
  const phases = [...new Set(items.map((i) => i.phase))];
  openDialog((close) => {
    const form = h(
      "form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const body = {
            title: f.get("title"),
            description: f.get("description"),
            phase: f.get("phase"),
            dueDate: f.get("dueDate"),
            sortOrder: Number(f.get("sortOrder")),
            requiresFile: f.has("requiresFile"),
          };
          run(form.querySelector("[type=submit]"), async () => {
            await api(
              item ? "PUT" : "POST",
              item ? `/api/admin/requirements/${item.id}` : "/api/admin/requirements",
              body,
            );
            close();
            toast(item ? "Requirement saved." : "Requirement added.");
            await render();
          });
        },
      },
      h("h2", {}, item ? "Edit requirement" : "Add requirement"),
      h(
        "label",
        { className: "field" },
        "Title",
        h("input", { name: "title", value: item?.title ?? "", maxLength: 200, required: true }),
      ),
      h(
        "label",
        { className: "field" },
        "Description",
        h("input", { name: "description", value: item?.description ?? "", maxLength: 1000 }),
      ),
      h(
        "div",
        { className: "row2" },
        h(
          "label",
          { className: "field" },
          "Phase",
          h("input", {
            name: "phase",
            value: item?.phase ?? phases.at(-1) ?? "General",
            maxLength: 60,
            list: "phase-options",
          }),
          h("datalist", { id: "phase-options" }, ...phases.map((p) => h("option", { value: p }))),
        ),
        h(
          "label",
          { className: "field" },
          "Due date",
          h("input", { name: "dueDate", type: "date", value: item?.dueDate ?? "" }),
        ),
      ),
      h(
        "label",
        { className: "field" },
        "Order",
        h("input", { name: "sortOrder", type: "number", step: 1, value: item?.sortOrder ?? items.length + 1 }),
      ),
      h(
        "label",
        { className: "check" },
        h("input", { name: "requiresFile", type: "checkbox", checked: item ? item.requiresFile : true }),
        "Requires a file upload",
      ),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", className: "btn outline", onclick: close }, "Cancel"),
        h("button", { type: "submit", className: "btn" }, item ? "Save changes" : "Add requirement"),
      ),
    );
    return form;
  });
}

async function requirementsView() {
  const { items } = await api("GET", "/api/requirements");
  const groups = groupByPhase(items);

  const remove = async (item) => {
    const ok = await confirmDialog({
      title: "Delete requirement?",
      text: `“${item.title}” and every student's submission for it will be permanently deleted.`,
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    await run(null, async () => {
      await api("DELETE", `/api/admin/requirements/${item.id}`);
      toast("Requirement deleted.");
      await render();
    });
  };

  return h(
    "div",
    {},
    pageHead(
      "Requirements",
      "What every student has to complete, grouped by phase.",
      h(
        "button",
        { type: "button", className: "btn", onclick: () => requirementDialog(null, items) },
        icon("plus", 16),
        "Add requirement",
      ),
    ),
    ...(groups.length
      ? groups.map((g) =>
          h(
            "section",
            { className: "card phase" },
            h(
              "div",
              {
                className: "phase-title",
                style: "padding:14px 18px;background:var(--surface-2);border-bottom:1px solid var(--border)",
              },
              h("h2", {}, g.name),
              h("small", { className: "muted" }, `${g.items.length} requirement${g.items.length === 1 ? "" : "s"}`),
            ),
            ...g.items.map((item) =>
              h(
                "div",
                { className: "req-row" },
                h(
                  "div",
                  { className: "act-icon", style: "width:38px;height:38px" },
                  icon(item.requiresFile ? "file" : "check", 18),
                ),
                h(
                  "div",
                  { className: "grow" },
                  h("b", {}, item.title),
                  h(
                    "p",
                    {},
                    [item.requiresFile ? "File upload" : "No file", item.dueDate && `Due ${fmtDay(item.dueDate)}`]
                      .filter(Boolean)
                      .join(" · "),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "icon-btn plain sm",
                    "aria-label": `Edit ${item.title}`,
                    title: "Edit",
                    onclick: () => requirementDialog(item, items),
                  },
                  icon("pencil", 16),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "icon-btn plain sm",
                    "aria-label": `Delete ${item.title}`,
                    title: "Delete",
                    style: "color:var(--err)",
                    onclick: () => remove(item),
                  },
                  icon("trash", 16),
                ),
              ),
            ),
          ),
        )
      : [h("div", { className: "card" }, empty("No requirements yet", "Add the first one to get started."))]),
  );
}

// ======================================================================
// Shell
// ======================================================================

const TABS = [
  { id: "checklist", text: "Checklist", icon: "list", build: checklistView },
  { id: "review", text: "Review", icon: "check", build: reviewView, show: isStaff },
  { id: "students", text: "Students", icon: "users", build: studentsView, show: isStaff },
  { id: "requirements", text: "Requirements", icon: "file", build: requirementsView, show: isAdmin },
  { id: "profile", text: "Profile", icon: "user", build: profileView },
];

let active = location.hash.slice(1) || "checklist";
let renderToken = 0;

function paintTabs(available) {
  const desktop = document.getElementById("tabs");
  const mobile = document.getElementById("tabs-mobile");
  const make = (withIcon) =>
    available.map((t) =>
      h(
        "button",
        {
          type: "button",
          "aria-current": String(t.id === active),
          onclick: () => {
            location.hash = t.id;
          },
        },
        withIcon && icon(t.icon, 16),
        t.text,
      ),
    );
  desktop.replaceChildren(...make(true));
  mobile.replaceChildren(...make(false));
}

async function render() {
  const available = TABS.filter((t) => !t.show || t.show());
  if (!available.some((t) => t.id === active)) active = "checklist";
  paintTabs(available);
  const token = ++renderToken;
  const scrollY = window.scrollY;
  try {
    const node = await available.find((t) => t.id === active).build();
    if (token !== renderToken) return; // a newer render started
    view.replaceChildren(node);
    window.scrollTo(0, scrollY);
  } catch (err) {
    if (err.status === 401) return (location.href = "/");
    view.replaceChildren(h("div", { className: "card" }, empty("Could not load this page", err.message)));
  }
}

window.addEventListener("hashchange", () => {
  active = location.hash.slice(1) || "checklist";
  view.replaceChildren(h("div", { className: "skeleton" }), h("div", { className: "skeleton" }));
  window.scrollTo(0, 0);
  render();
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("POST", "/api/logout").catch(() => {});
  location.href = "/";
});

try {
  me = (await api("GET", "/api/me")).user;
} catch {
  location.href = "/";
}

if (me) {
  document.getElementById("who").textContent = `Hi, ${(me.fullName || me.email).split(/[\s@]/)[0]}`;
  await render();
  const verified = new URLSearchParams(location.search).get("verified");
  if (verified) {
    toast(
      verified === "1"
        ? "Email verified. You can now submit requirements."
        : "That verification link is invalid or has expired.",
      verified === "1" ? "ok" : "err",
    );
    history.replaceState(null, "", location.pathname + location.hash);
  }
}
