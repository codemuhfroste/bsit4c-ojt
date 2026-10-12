import { api, avatar, fmtDate, fmtDay, h, icon, openDialog, parseDay, toast } from "/common.js";
import { trackerView } from "/tracker.js";

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
  na: { label: "N/A for now", icon: "minus" },
};
// Closed requirements ("N/A for now") are shown crossed out and cannot be submitted.
const statusOf = (item) => (!item.available ? "na" : (item.submission?.status ?? "todo"));
const LOCATION = { inside: "Inside Legazpi", outside: "Outside Legazpi" };
const companyCount = (n) => `${n} ${n === 1 ? "company" : "companies"}`;

// "https://www.facebook.com/acme/" -> "facebook.com/acme"
function prettyLink(href) {
  try {
    const u = new URL(href);
    return u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, ""));
  } catch {
    return href;
  }
}

let myCompanies = [];
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

const RESPONSE = {
  none: { label: "No response", icon: "clock", cls: "submitted" },
  accepted: { label: "Accepted", icon: "check", cls: "approved" },
  denied: { label: "Denied", icon: "x", cls: "rejected" },
};
const RESPONSE_ORDER = ["none", "accepted", "denied"];

// A status tag. With `onChange` it is a button that flips on double-click (or Enter); without it, plain text.
function tag(label, iconName, cls, onChange, what) {
  if (!onChange) return h("span", { className: `pill ${cls}` }, icon(iconName, 12), label);
  const el = h(
    "button",
    {
      type: "button",
      className: `pill tog ${cls}`,
      title: `${what}: double-click to change`,
      "aria-label": `${what}: ${label}. Double-click or press Enter to change.`,
    },
    icon(iconName, 12),
    label,
  );
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    onChange(el);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChange(el);
    }
  });
  return el;
}

// Location, applied and response tags for one company. `patch(fields, button)` makes them toggleable.
function companyTags(c, patch, staff = false) {
  const tags = [
    tag(
      LOCATION[c.location],
      "pin",
      c.location === "inside" ? "todo" : "",
      patch && ((el) => patch({ location: c.location === "inside" ? "outside" : "inside" }, el)),
      "Location",
    ),
    tag(
      c.applied ? "Applied" : "Not applied",
      c.applied ? "check" : "minus",
      c.applied ? "approved" : "na",
      patch && ((el) => patch({ applied: !c.applied }, el)),
      "Application",
    ),
  ];
  if (c.applied) {
    const r = RESPONSE[c.response];
    const next = RESPONSE_ORDER[(RESPONSE_ORDER.indexOf(c.response) + 1) % RESPONSE_ORDER.length];
    tags.push(tag(r.label, r.icon, r.cls, patch && ((el) => patch({ response: next }, el)), "Response"));
  }
  if (!staff) {
    // Set by advisers: whether the university has a MoA with this company, and the review result.
    if (c.moa) tags.push(tag("MoA with BU", "shield", "approved"));
    if (c.review === "approved") tags.push(tag("Approved", "check", "approved"));
    else if (c.review === "rejected") tags.push(tag("Rejected", "x", "rejected"));
  }
  return h("div", { className: "tags" }, ...tags);
}

function buildCompanyRow(c, { patch, actions = [], staff = false }) {
  return h(
    "li",
    {},
    h(
      "div",
      { className: "grow" },
      h("b", {}, c.name),
      h("a", { href: c.link, target: "_blank", rel: "noopener noreferrer" }, icon("link", 13), prettyLink(c.link)),
      c.email
        ? h("a", { href: `mailto:${encodeURIComponent(c.email)}` }, icon("mail", 13), c.email)
        : h("span", { className: "muted mail" }, icon("mail", 13), "Email: N/A"),
    ),
    companyTags(c, patch, staff),
    ...actions,
    !staff &&
      c.reviewNote &&
      c.review !== "pending" &&
      h("div", { className: `callout ${c.review} company-note` }, h("b", {}, "Reviewer: "), c.reviewNote),
  );
}

const companyRow = (c, patch, ...actions) => buildCompanyRow(c, { patch, actions });

// A company as an adviser sees it: Approve / Reject with a note, and a double-click MoA tag. Changes show
// immediately and are undone with a message if the server refuses them.
function staffCompanyRow(initial) {
  let c = initial;
  let li;

  const swap = () => {
    const refocus = li?.contains(document.activeElement) && document.activeElement.classList.contains("moa-tag");
    const next = build();
    li.replaceWith(next);
    li = next;
    if (refocus) li.querySelector(".moa-tag")?.focus();
  };

  async function change(next, request, success) {
    const before = c;
    c = { ...c, ...next };
    swap();
    try {
      await request();
      if (success) toast(success);
    } catch (err) {
      if (err.status === 401) return (location.href = "/");
      toast(err.message, "err");
      c = before;
      swap();
    }
  }

  const setMoa = () => {
    const moa = !c.moa; // decide the new value first: change() updates `c` before the request runs
    return change({ moa }, () => api("PATCH", `/api/admin/companies/${c.id}`, { moa }));
  };

  const decide = (status, noteText) => {
    const note = noteText.trim();
    if (status === "rejected" && !note) return toast("Tell the student why it was rejected.", "err");
    return change(
      { review: status, reviewNote: note },
      () => api("POST", `/api/admin/companies/${c.id}/review`, { status, note }),
      status === "approved" ? `${c.name} approved.` : `${c.name} sent back.`,
    );
  };

  function build() {
    const row = buildCompanyRow(c, { staff: true });
    const state =
      c.review === "approved"
        ? h("span", { className: "pill approved" }, icon("check", 12), "Approved")
        : c.review === "rejected"
          ? h("span", { className: "pill rejected" }, icon("x", 12), "Rejected")
          : h("span", { className: "pill na" }, "Not reviewed");
    const moa = tag(c.moa ? "MoA with BU" : "No MoA", "shield", c.moa ? "approved" : "na", setMoa, "MoA with BU");
    moa.classList.add("moa-tag");
    row.querySelector(".tags").append(moa, state);

    const note = h("input", {
      type: "text",
      maxLength: 300,
      placeholder: "Note (required to reject)",
      "aria-label": `Note for ${c.name}`,
      value: c.reviewNote,
    });
    row.append(
      h(
        "div",
        { className: "review-line" },
        note,
        h(
          "button",
          { type: "button", className: "btn ok sm", onclick: () => decide("approved", note.value) },
          icon("check", 14),
          "Approve",
        ),
        h(
          "button",
          { type: "button", className: "btn danger sm", onclick: () => decide("rejected", note.value) },
          icon("x", 14),
          "Reject",
        ),
      ),
    );
    return row;
  }

  li = build();
  return li;
}

// ---- Company list: every change shows on screen immediately and syncs to the server in the background ----

let syncQueue = Promise.resolve();
let pendingSync = 0;
let needsRefresh = false;
let tempSeq = 0;
const realIds = new Map(); // temporary id of a just-added company -> the id the server gave it
let repaintCompanies = () => {};

const MAX_COMPANIES = 20;
const EMAIL_RE = /^[A-Za-z0-9._+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Mirrors the server's checks so a bad entry is caught before it is shown (the server still has the last word).
function normalizeCompany(raw, editing) {
  const name = raw.name.trim();
  if (!name) throw new Error("Company name is required.");
  let text = raw.link.trim();
  if (!text) throw new Error("Add the company's Facebook page or website.");
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That link does not look valid.");
  }
  if (!url.hostname.includes(".") || url.href.length > 300) throw new Error("That link does not look valid.");

  let email = "";
  if (!raw.noEmail) {
    email = raw.email.trim().toLowerCase();
    if (!email) throw new Error("Add the company's email, or tick “No email (N/A)”.");
    if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address.");
  }
  if (!editing && myCompanies.length >= MAX_COMPANIES) {
    throw new Error(`You can list up to ${MAX_COMPANIES} companies.`);
  }
  const applied = Boolean(raw.applied);
  return { name, link: url.href, email, location: raw.location, applied, response: applied ? raw.response : "none" };
}

const toApi = (fields) => ({ ...fields, email: fields.email || "N/A" });
const serverId = (id) => realIds.get(id) ?? id; // still a "tmp-…" string if creating it failed

// Warn before leaving while a change is still being saved.
window.addEventListener("beforeunload", (e) => {
  if (pendingSync > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Re-render the whole checklist (status, progress ring) once every change is saved and no form is open.
function maybeRefresh() {
  if (needsRefresh && pendingSync === 0 && !document.querySelector("#view .panel")) {
    needsRefresh = false;
    render({ background: true });
  }
}

// Runs `task` after all earlier changes have finished. If the server refuses one, fall back to its list and say why.
function enqueue(task, { refresh = false } = {}) {
  if (refresh) needsRefresh = true;
  pendingSync++;
  syncQueue = syncQueue
    .then(task)
    .catch(async (err) => {
      if (err.status === 401) return (location.href = "/");
      toast(err.message, "err");
      try {
        myCompanies = (await api("GET", "/api/companies")).companies;
      } catch {
        // offline: keep what is on screen
      }
      needsRefresh = true;
      repaintCompanies();
    })
    .finally(() => {
      pendingSync--;
      maybeRefresh();
    });
}

function addCompany(fields) {
  const tmp = `tmp-${++tempSeq}`;
  myCompanies = [...myCompanies, { id: tmp, ...fields, createdAt: new Date().toISOString() }];
  repaintCompanies();
  toast("Company added and sent to your coordinator.");
  enqueue(
    async () => {
      const { id } = await api("POST", "/api/companies", toApi(fields));
      realIds.set(tmp, id);
    },
    { refresh: true },
  );
}

function updateCompany(c, fields) {
  myCompanies = myCompanies.map((x) => (x.id === c.id ? { ...x, ...fields } : x));
  repaintCompanies();
  toast("Company updated.");
  enqueue(
    async () => {
      const id = serverId(c.id);
      if (typeof id === "number") await api("PUT", `/api/companies/${id}`, toApi(fields));
    },
    { refresh: true },
  );
}

function removeCompany(c) {
  myCompanies = myCompanies.filter((x) => x.id !== c.id);
  repaintCompanies();
  toast("Company removed.");
  enqueue(
    async () => {
      const id = serverId(c.id);
      if (typeof id === "number") await api("DELETE", `/api/companies/${id}`);
    },
    { refresh: true },
  );
}

// Tag toggles (location / applied / response): `fields` holds just the one thing that changed.
function patchCompany(c, fields) {
  const next = { ...c, ...fields };
  if (!next.applied) next.response = "none"; // same rule the server applies
  myCompanies = myCompanies.map((x) => (x.id === c.id ? next : x));
  repaintCompanies();
  enqueue(async () => {
    const id = serverId(c.id);
    if (typeof id === "number") await api("PATCH", `/api/companies/${id}`, fields);
  });
}

function companyPanel(editing, close) {
  const name = h("input", {
    name: "name",
    value: editing?.name ?? "",
    maxLength: 150,
    required: true,
    placeholder: "e.g. Acme Software Inc.",
  });
  const link = h("input", {
    name: "link",
    value: editing?.link ?? "",
    maxLength: 300,
    required: true,
    placeholder: "facebook.com/yourpage or www.company.com",
  });
  const email = h("input", {
    name: "email",
    type: "email",
    value: editing?.email ?? "",
    maxLength: 254,
    placeholder: "hr@company.com",
  });
  const noEmail = h("input", {
    type: "checkbox",
    checked: Boolean(editing && !editing.email),
    onchange: () => {
      email.disabled = noEmail.checked;
      if (noEmail.checked) email.value = "";
    },
  });
  email.disabled = noEmail.checked;

  let where = editing?.location ?? "inside";
  const kinds = ["inside", "outside"];
  const options = kinds.map((value) =>
    h(
      "button",
      {
        type: "button",
        role: "radio",
        onclick: () => {
          where = value;
          paint();
        },
      },
      icon("pin", 14),
      LOCATION[value],
    ),
  );
  const paint = () => options.forEach((btn, i) => btn.setAttribute("aria-checked", String(kinds[i] === where)));
  paint();

  const response = h(
    "select",
    { name: "response" },
    ...RESPONSE_ORDER.map((key) =>
      h("option", { value: key, selected: key === (editing?.response ?? "none") }, RESPONSE[key].label),
    ),
  );
  const responseField = h("label", { className: "field" }, "Did they reply?", response);
  const applied = h("input", {
    type: "checkbox",
    checked: Boolean(editing?.applied),
    onchange: () => {
      responseField.hidden = !applied.checked;
    },
  });
  responseField.hidden = !applied.checked;

  const save = h("button", { type: "submit", className: "btn sm" }, editing ? "Save changes" : "Add company");
  return h(
    "form",
    {
      className: "panel",
      onsubmit: (e) => {
        e.preventDefault();
        let fields;
        try {
          fields = normalizeCompany(
            {
              name: name.value,
              link: link.value,
              email: email.value,
              noEmail: noEmail.checked,
              location: where,
              applied: applied.checked,
              response: response.value,
            },
            editing,
          );
        } catch (err) {
          return toast(err.message, "err");
        }
        if (editing) updateCompany(editing, fields);
        else addCompany(fields);
        close();
      },
    },
    h("label", { className: "field" }, "Company name", name),
    h("label", { className: "field" }, "Facebook page or website", link),
    h("label", { className: "field" }, "Company email", email),
    h("label", { className: "check" }, noEmail, "No email (N/A)"),
    h(
      "div",
      { className: "field" },
      "Where is it?",
      h("div", { className: "seg2", role: "radiogroup", "aria-label": "Location" }, ...options),
    ),
    h("label", { className: "check" }, applied, "I already applied here"),
    responseField,
    h(
      "div",
      { className: "actions" },
      h("button", { type: "button", className: "btn outline sm", onclick: close }, "Cancel"),
      save,
    ),
  );
}

// The student's own list: tags toggle on double-click, and each row has edit/remove buttons.
function companyList({ onEdit, onRemove, onPatch }) {
  if (!myCompanies.length) {
    return h(
      "p",
      { className: "desc" },
      "No companies yet. Add the ones you find. They are sent to your coordinator right away.",
    );
  }
  return h(
    "div",
    {},
    h(
      "ul",
      { className: "company-list" },
      ...myCompanies.map((c) =>
        companyRow(
          c,
          (fields, el) => onPatch(c, fields, el),
          h(
            "button",
            {
              type: "button",
              className: "icon-btn plain sm",
              "aria-label": `Edit ${c.name}`,
              title: "Edit",
              onclick: () => onEdit(c),
            },
            icon("pencil", 15),
          ),
          h(
            "button",
            {
              type: "button",
              className: "icon-btn plain sm",
              "aria-label": `Remove ${c.name}`,
              title: "Remove",
              style: "color:var(--err)",
              onclick: (e) => onRemove(c, e.currentTarget),
            },
            icon("trash", 15),
          ),
        ),
      ),
    ),
    h("p", { className: "hint" }, "Tip: double-click a tag (location, applied, response) to change it."),
  );
}

function activity(item) {
  const status = statusOf(item);
  const sub = item.submission;
  const na = status === "na";
  const isCompanies = item.kind === "companies";
  const locked = status === "approved";
  const blocked = !me.emailVerified;
  const li = h("li", { className: `activity${na ? " na" : ""}`, id: `req-${item.id}`, "data-status": status });
  let panel = null;

  const dismissPanel = () => {
    panel?.remove();
    panel = null;
  };
  const closePanel = () => {
    dismissPanel();
    maybeRefresh(); // a refresh may have been waiting for this form to close
  };
  const openPanel = (el) => {
    dismissPanel();
    panel = el;
    li.append(el);
  };
  const togglePanel = () => (panel ? closePanel() : openPanel(uploadPanel(item, closePanel)));
  const openCompanyForm = (editing) => openPanel(companyPanel(editing, closePanel));

  // Built from the current list so a toggle can repaint just this part without refetching anything.
  const buildMeta = () => {
    const inside = myCompanies.filter((c) => c.location === "inside").length;
    const applied = myCompanies.filter((c) => c.applied).length;
    const accepted = myCompanies.filter((c) => c.response === "accepted").length;
    return h(
      "div",
      { className: "meta" },
      item.optional && !na && h("span", { className: "pill todo" }, "Optional"),
      !na && dueChip(item, status),
      isCompanies
        ? [
            h("span", { className: "pill" }, icon("building", 13), companyCount(myCompanies.length)),
            myCompanies.length > 0 &&
              h(
                "span",
                { className: "pill" },
                icon("pin", 13),
                `${inside} inside · ${myCompanies.length - inside} outside Legazpi`,
              ),
            applied > 0 && h("span", { className: "pill approved" }, icon("check", 13), `${applied} applied`),
            accepted > 0 && h("span", { className: "pill approved" }, icon("check", 13), `${accepted} accepted`),
          ]
        : item.requiresFile
          ? h("span", { className: "pill" }, icon("file", 13), "PDF, PNG or JPG")
          : h("span", { className: "pill" }, icon("check", 13), "No file needed"),
      sub?.fileName && h("a", { href: `/api/submissions/${sub.id}/file` }, icon("download", 14), sub.fileName),
      sub && !na && h("span", { className: "muted" }, `Updated ${fmtDate(sub.updatedAt)}`),
    );
  };
  const buildList = () =>
    companyList({
      onEdit: openCompanyForm,
      onRemove: removeCompany,
      onPatch: patchCompany,
    });
  let metaEl = buildMeta();
  let listEl = isCompanies && !na ? buildList() : null;
  if (listEl) repaintCompanies = repaint;

  function repaint() {
    // Keep keyboard focus on the same tag after the rows are rebuilt.
    let focus = null;
    if (listEl?.contains(document.activeElement)) {
      const rows = [...listEl.querySelectorAll("li")];
      const row = rows.findIndex((r) => r.contains(document.activeElement));
      const tagIndex = row < 0 ? -1 : [...rows[row].querySelectorAll(".tags .tog")].indexOf(document.activeElement);
      if (tagIndex >= 0) focus = [row, tagIndex];
    }
    const meta = buildMeta();
    metaEl.replaceWith(meta);
    metaEl = meta;
    if (listEl) {
      const list = buildList();
      listEl.replaceWith(list);
      listEl = list;
      if (focus) list.querySelectorAll("li")[focus[0]]?.querySelectorAll(".tags .tog")[focus[1]]?.focus();
    }
  }

  const withdraw = () =>
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
    );

  const side = h("div", { className: "act-side" });
  const lockTitle = blocked ? "Verify your email to submit" : undefined;

  if (na) {
    put(side, pill("na", false));
  } else if (isCompanies) {
    // The company list is submitted automatically; students can keep adding to it at any time.
    const add = h(
      "button",
      {
        type: "button",
        className: `btn sm done-btn${myCompanies.length ? " outline" : ""}`,
        onclick: () => openCompanyForm(null),
      },
      icon("plus", 15),
      "Add company",
    );
    const state = locked
      ? h("span", { className: "btn ok sm done-btn", style: "pointer-events:none" }, icon("check", 15), "Done")
      : status === "todo"
        ? null
        : pill(status, false);
    put(side, state, add);
  } else if (locked) {
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
        withdraw(),
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
    h("div", { className: "act-icon" }, icon(isCompanies ? "building" : item.requiresFile ? "file" : "check", 22)),
    h(
      "div",
      { className: "act-body" },
      h("h3", {}, item.title),
      item.description && h("p", { className: "desc" }, item.description),
      metaEl,
      listEl,
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
          const glyph = { approved: "check", submitted: "clock", rejected: "x", todo: "check", na: "minus" }[status];
          return h(
            "li",
            { className: `step${status === "na" ? " na" : ""}` },
            h("span", { className: `node ${status}` }, icon(glyph, 11)),
            h(
              "button",
              { type: "button", onclick: () => scrollToItem(item.id) },
              item.optional ? `${item.title} · optional` : item.title,
            ),
          );
        }),
      ),
    );
  }
  return aside;
}

async function checklistView() {
  const [{ items, progress }, mine] = await Promise.all([
    api("GET", "/api/requirements"),
    api("GET", "/api/companies"),
  ]);
  myCompanies = mine.companies;
  const count = (s) => items.filter((i) => statusOf(i) === s).length; // everything listed (filter chips)
  const counted = items.filter((i) => !i.optional); // optional items do not count toward progress
  const countRequired = (s) => counted.filter((i) => statusOf(i) === s).length;
  const pct = progress.total ? Math.round((progress.approved / progress.total) * 100) : 0;
  const next = counted.find((i) => ["todo", "rejected"].includes(statusOf(i)));
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
        h("span", {}, h("b", {}, countRequired("submitted")), " in review"),
        h("span", {}, h("b", {}, countRequired("rejected")), " need changes"),
        h("span", {}, h("b", {}, countRequired("todo")), " to do"),
      ),
      items.some((i) => i.optional && i.available) &&
        h("p", { className: "nextup" }, "Tasks marked Optional do not count toward your progress."),
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
      ["na", "N/A for now", count("na")],
    ]
      .filter(([key, , n]) => key !== "na" || n > 0)
      .map(([key, text, n]) =>
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
      const open = phase.items.filter((i) => i.available && !i.optional);
      const optionalOnly = open.length === 0 && phase.items.some((i) => i.available);
      const done = open.filter((i) => statusOf(i) === "approved").length;
      return h(
        "details",
        { className: "card phase", open: phase.items.some((i) => i.available) || filter === "na" },
        h(
          "summary",
          {},
          h(
            "div",
            { className: "phase-title" },
            h("h2", {}, phase.name),
            h(
              "small",
              { className: "muted" },
              open.length ? `${done} of ${open.length} approved` : optionalOnly ? "Optional" : "N/A for now",
            ),
          ),
          h(
            "div",
            { className: "meter", style: "margin-left:auto" },
            h("i", { style: `width:${open.length ? (done / open.length) * 100 : 0}%` }),
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
    h("span", {}, "Verify your email to upload files. Check your inbox, and your spam folder, for the link."),
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

function deleteAccountDialog() {
  openDialog((close) => {
    const password = h("input", {
      name: "password",
      type: "password",
      autocomplete: "current-password",
      required: true,
    });
    const form = h(
      "form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          run(form.querySelector("[type=submit]"), async () => {
            await api("DELETE", "/api/me", { password: password.value });
            close();
            toast("Your account and data were deleted.");
            setTimeout(() => (location.href = "/"), 900);
          });
        },
      },
      h("h2", {}, "Delete my account"),
      h(
        "p",
        { className: "muted", style: "margin-bottom:14px" },
        "This permanently deletes your account, company list, uploaded files and review records. It cannot be undone.",
      ),
      h("label", { className: "field" }, "Confirm with your password", password),
      h(
        "div",
        { className: "actions" },
        h("button", { type: "button", className: "btn outline", onclick: close }, "Cancel"),
        h("button", { type: "submit", className: "btn danger" }, "Delete everything"),
      ),
    );
    return form;
  });
}

// Everyone must accept the current Privacy Notice. People who signed up before it existed see this once.
function privacyGate() {
  return new Promise((resolve) => {
    openDialog(
      () => {
        const agree = h("input", { type: "checkbox", id: "gate-agree" });
        const accept = h("button", { type: "button", className: "btn", disabled: true }, "Accept and continue");
        agree.addEventListener("change", () => (accept.disabled = !agree.checked));
        accept.addEventListener("click", () =>
          run(accept, async () => {
            me = (await api("POST", "/api/me/privacy", { accept: true })).user;
            document.querySelector("dialog.modal")?.remove();
            resolve();
          }),
        );
        return h(
          "div",
          { style: "padding:22px" },
          h("h2", {}, "Please review our Privacy Notice"),
          h(
            "p",
            { className: "muted", style: "margin-bottom:12px" },
            "We now have a Privacy Notice under the Data Privacy Act. It explains what this app keeps about you (name, student ID, email, your company list and uploaded files), who can see it, that it is stored outside the Philippines, how long we keep it, and your rights, including downloading or deleting your data at any time.",
          ),
          h(
            "p",
            { style: "margin-bottom:14px" },
            h("a", { href: "/privacy.html", target: "_blank", rel: "noopener" }, "Read the full Privacy Notice"),
          ),
          h("label", { className: "check", for: "gate-agree" }, agree, "I have read and accept the Privacy Notice."),
          h(
            "div",
            { className: "actions" },
            h(
              "button",
              {
                type: "button",
                className: "btn ghost",
                onclick: async () => {
                  await api("POST", "/api/logout").catch(() => {});
                  location.href = "/";
                },
              },
              "Log out",
            ),
            h(
              "button",
              { type: "button", className: "btn danger-outline", onclick: deleteAccountDialog },
              "Delete my account",
            ),
            accept,
          ),
        );
      },
      { dismissable: false, wide: true },
    );
  });
}

function privacyCard() {
  return h(
    "section",
    { className: "card privacy-card", style: "margin-top:22px" },
    h("h2", {}, "Privacy & data"),
    h(
      "p",
      { className: "muted", style: "font-size:.9rem" },
      "You decide what happens to your information. Download a copy of everything we hold about you, or delete your account and all of it. See the Privacy Notice for details.",
    ),
    h(
      "div",
      { className: "actions" },
      h(
        "a",
        { className: "btn outline sm", href: "/api/me/export", download: "" },
        icon("download", 15),
        "Download my data",
      ),
      h(
        "button",
        { type: "button", className: "btn danger-outline sm", onclick: deleteAccountDialog },
        icon("trash", 15),
        "Delete my account",
      ),
      h("a", { className: "btn ghost sm", href: "/privacy.html", target: "_blank", rel: "noopener" }, "Privacy Notice"),
    ),
  );
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
                  i.kind === "companies"
                    ? "Company list"
                    : i.submission.fileName
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
    privacyCard(),
  );
}

// ======================================================================
// Review queue (staff)
// ======================================================================

let reviewFilter = "submitted";

// Note box + Approve / Reject buttons for one submission (used in the review queue and on a student's page).
function reviewControls(submissionId, initialNote = "") {
  const note = h("input", {
    type: "text",
    maxLength: 500,
    placeholder: "Note (required to reject)",
    "aria-label": "Reviewer note",
    value: initialNote,
  });
  const decide = (status) => (e) =>
    run(e.currentTarget, async () => {
      await api("POST", `/api/admin/submissions/${submissionId}/review`, { status, note: note.value });
      toast(status === "approved" ? "Approved." : "Sent back for changes.");
      await render();
    });
  return h(
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
      h("button", { type: "button", className: "btn danger sm", onclick: decide("rejected") }, icon("x", 15), "Reject"),
    ),
  );
}

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

  const search = h("input", {
    type: "search",
    placeholder: "Search by student, ID or requirement",
    "aria-label": "Search submissions",
  });
  const list = h("div", { className: "list" });
  if (!submissions.length)
    list.append(h("div", { className: "card" }, empty("All caught up", "There is nothing in this view.")));

  for (const s of submissions) {
    const card = h(
      "article",
      {
        className: "card review-card",
        "data-text": [s.fullName, s.studentId, s.email, s.requirement].join(" ").toLowerCase(),
      },
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
            h(
              "a",
              { href: `#students/${s.userId}`, className: "name-link", title: "Open this student's page" },
              h("b", {}, s.fullName || s.email),
            ),
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
        s.kind === "companies" &&
          h("ul", { className: "company-list" }, ...(s.companies ?? []).map((c) => staffCompanyRow(c))),
      ),
      reviewControls(s.id, s.note),
    );
    list.append(card);
  }

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const card of list.querySelectorAll("article")) card.hidden = Boolean(q) && !card.dataset.text.includes(q);
  });

  return h(
    "div",
    {},
    pageHead("Review submissions", "Approve documents or send them back with a note."),
    chips,
    h("div", { className: "toolbar" }, search),
    list,
  );
}

// One student's whole checklist: every requirement, their files, their companies, with review controls.
async function studentDetailView(id) {
  const { user: u, items, progress, companies } = await api("GET", `/api/admin/users/${id}`);
  const required = items.filter((i) => i.available && !i.optional);
  const inReview = required.filter((i) => statusOf(i) === "submitted").length;
  const todo = required.filter((i) => statusOf(i) === "todo").length;
  const info = (iconName, label, value) =>
    h("div", {}, h("dt", {}, icon(iconName, 14), label), h("dd", {}, value || "—"));

  const head = h(
    "section",
    { className: "card" },
    h(
      "div",
      { className: "profile-top" },
      h(
        "div",
        { className: "profile-id" },
        avatar(u.fullName, u.email, 64),
        h(
          "div",
          {},
          h("h1", {}, u.fullName || u.email),
          h(
            "div",
            { className: "line" },
            h("span", {}, u.joined ? `Joined ${fmtDate(u.joined)}` : "Join date unknown"),
            h("span", { className: "pill solid" }, ROLE_LABEL[u.role]),
            u.emailVerified
              ? h("span", { className: "pill approved" }, icon("check", 13), "Verified")
              : h("span", { className: "pill submitted" }, icon("alert", 13), "Not verified"),
          ),
        ),
      ),
      h(
        "div",
        { className: "profile-actions" },
        h(
          "a",
          { className: "btn outline sm", href: `mailto:${encodeURIComponent(u.email)}` },
          icon("mail", 15),
          "Email student",
        ),
        isAdmin() &&
          u.id !== me.id &&
          u.role !== "admin" &&
          h(
            "button",
            {
              type: "button",
              className: "btn danger-outline sm",
              onclick: async () => {
                const ok = await confirmDialog({
                  title: "Delete this account?",
                  text: `This permanently erases ${u.fullName || u.email}'s account, company list, uploaded files and review records. Use it for a data-erasure request. It cannot be undone.`,
                  confirm: "Delete everything",
                  danger: true,
                });
                if (!ok) return;
                await run(null, async () => {
                  await api("DELETE", `/api/admin/users/${u.id}`);
                  toast("Account deleted.");
                  location.hash = "students";
                });
              },
            },
            icon("trash", 15),
            "Delete account",
          ),
      ),
    ),
    h(
      "dl",
      { className: "info-grid" },
      info("id", "Student ID", u.studentId),
      info("mail", "Email", u.email),
      info("list", "Progress", `${progress.approved} of ${progress.total} approved`),
    ),
  );

  const stat = (label, value) =>
    h("div", { className: "stat" }, h("small", { className: "muted" }, label), h("div", { className: "num" }, value));
  const stats = h(
    "div",
    { className: "stats" },
    stat("Approved", `${progress.approved}/${progress.total}`),
    stat("In review", inReview),
    stat("To do", todo),
  );

  const rows = items.map((item) => {
    const status = statusOf(item);
    const sub = item.submission;
    const isCompanies = item.kind === "companies";
    return h(
      "li",
      { className: `activity${status === "na" ? " na" : ""}`, "data-status": status },
      h("div", { className: "act-icon" }, icon(isCompanies ? "building" : item.requiresFile ? "file" : "check", 22)),
      h(
        "div",
        { className: "act-body" },
        h("h3", {}, item.title),
        h(
          "div",
          { className: "meta" },
          pill(status),
          item.optional && h("span", { className: "pill todo" }, "Optional"),
          sub?.fileName && h("a", { href: `/api/submissions/${sub.id}/file` }, icon("download", 14), sub.fileName),
          sub && status !== "na" && h("span", { className: "muted" }, `Updated ${fmtDate(sub.updatedAt)}`),
        ),
        isCompanies &&
          status !== "na" &&
          (companies.length
            ? h("ul", { className: "company-list" }, ...companies.map((c) => staffCompanyRow(c)))
            : h("p", { className: "desc" }, "No companies listed yet.")),
        sub?.note && h("div", { className: `callout ${status}` }, h("b", {}, "Note: "), sub.note),
      ),
      h("div", { className: "act-side" }, sub && status !== "na" ? reviewControls(sub.id, sub.note) : null),
    );
  });

  return h(
    "div",
    { className: "profile-wrap" },
    h("a", { href: "#students", className: "btn ghost sm", style: "margin-bottom:12px" }, "← All students"),
    head,
    stats,
    h("div", { className: "section-head" }, h("h2", {}, "Requirements and submissions")),
    h("section", { className: "card phase" }, h("ul", { className: "activities" }, ...rows)),
  );
}

// ======================================================================
// Students (staff; admins can change roles)
// ======================================================================

async function studentsView(arg) {
  if (arg) return studentDetailView(arg);
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
          {
            className: "clickable",
            onclick: (e) => {
              if (!e.target.closest("a, select, button")) location.hash = `students/${u.id}`;
            },
          },
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
                h("a", { href: `#students/${u.id}`, className: "name-link" }, h("b", {}, u.fullName || "—")),
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
            u.inReview > 0 && h("small", {}, `${u.inReview} awaiting review`),
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
    pageHead(
      "Students",
      `${users.length} account${users.length === 1 ? "" : "s"} · ${totalRequirements} required ${totalRequirements === 1 ? "task" : "tasks"}`,
      h(
        "a",
        { className: "btn outline sm", href: "/api/admin/export/progress.csv", download: "" },
        icon("download", 15),
        "Progress CSV",
      ),
      h(
        "a",
        { className: "btn outline sm", href: "/api/admin/export/companies.csv", download: "" },
        icon("download", 15),
        "Companies CSV",
      ),
    ),
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
            requiresFile: item?.kind === "companies" ? false : f.has("requiresFile"),
            available: f.has("available"),
            optional: f.has("optional"),
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
      item?.kind !== "companies" &&
        h(
          "label",
          { className: "check" },
          h("input", { name: "requiresFile", type: "checkbox", checked: item ? item.requiresFile : true }),
          "Requires a file upload",
        ),
      h(
        "label",
        { className: "check" },
        h("input", { name: "available", type: "checkbox", checked: item ? item.available : true }),
        "Open for students (untick to mark it N/A for now)",
      ),
      h(
        "label",
        { className: "check" },
        h("input", { name: "optional", type: "checkbox", checked: item ? item.optional : false }),
        "Optional (does not count toward progress)",
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
                  icon(item.kind === "companies" ? "building" : item.requiresFile ? "file" : "check", 18),
                ),
                h(
                  "div",
                  { className: "grow" },
                  h(
                    "b",
                    { style: item.available ? "" : "text-decoration:line-through;color:var(--muted)" },
                    item.title,
                  ),
                  h(
                    "p",
                    {},
                    [
                      item.kind === "companies" ? "Company list" : item.requiresFile ? "File upload" : "No file",
                      item.optional && "Optional",
                      item.dueDate && `Due ${fmtDay(item.dueDate)}`,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: `btn sm ${item.available ? "outline" : ""}`,
                    title: item.available ? "Close this requirement for now" : "Open this requirement to students",
                    onclick: (e) =>
                      run(e.currentTarget, async () => {
                        await api("PUT", `/api/admin/requirements/${item.id}`, {
                          title: item.title,
                          description: item.description,
                          phase: item.phase,
                          dueDate: item.dueDate ?? "",
                          sortOrder: item.sortOrder,
                          requiresFile: item.requiresFile,
                          available: !item.available,
                          optional: item.optional,
                        });
                        toast(item.available ? "Marked N/A for now." : "Opened for students.");
                        await render();
                      }),
                  },
                  item.available ? "Mark N/A" : "Open it",
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
  { id: "tracker", text: "Tracker", icon: "table", build: trackerView, show: isStaff },
  { id: "students", text: "Students", icon: "users", build: studentsView, show: isStaff },
  { id: "requirements", text: "Requirements", icon: "file", build: requirementsView, show: isAdmin },
  { id: "profile", text: "Profile", icon: "user", build: profileView },
];

const parseRoute = () => {
  const [tab, arg] = (location.hash.slice(1) || "checklist").split("/");
  return { tab: tab || "checklist", arg };
};
let active = parseRoute().tab;
let routeArg = parseRoute().arg; // e.g. the student id in #students/12
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

// `background` renders are quiet refreshes after a save: they must never replace the page under someone who has a
// form open (the typed text would vanish), so they wait and run again when that form closes.
async function render({ background = false } = {}) {
  const available = TABS.filter((t) => !t.show || t.show());
  if (!available.some((t) => t.id === active)) active = "checklist";
  paintTabs(available);
  const token = ++renderToken;
  const scrollY = window.scrollY;
  try {
    const node = await available.find((t) => t.id === active).build(routeArg);
    if (token !== renderToken) return; // a newer render started
    if (background && document.querySelector("#view .panel")) {
      needsRefresh = true; // a form was opened while this was loading
      return;
    }
    view.replaceChildren(node);
    window.scrollTo(0, scrollY);
  } catch (err) {
    if (err.status === 401) return (location.href = "/");
    view.replaceChildren(h("div", { className: "card" }, empty("Could not load this page", err.message)));
  }
}

window.addEventListener("hashchange", () => {
  ({ tab: active, arg: routeArg } = parseRoute());
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
  if (!me.privacyAccepted) await privacyGate();
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
