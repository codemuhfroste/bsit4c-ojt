// The student's roadmap: the four steps of getting an OJT company and its MoA, in order, with a "you are here" marker
// that follows what the student has actually done. Students were unsure what to do next, so this sits at the top of
// their Checklist. The wording comes from the OJT orientation; edit the text below as the process firms up.
import { h, icon } from "/common.js";

// The MoA template (the BU omnibus MoA). Step 2 shows a download button for it; leave this empty to show "Template coming soon".
const MOA_TEMPLATE_URL = "/files/OMNIBUS-MOA-Template.pdf";

// The deadline for submitting the reviewed MoA (step 3). Confirmed by the coordinator; edit here if it moves.
const MOA_DEADLINE = new Date(2026, 9, 28); // 28 Oct 2026, local time
const MOA_DEADLINE_LABEL = "Oct 28";

function deadlineTag() {
  const days = Math.ceil((MOA_DEADLINE - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return `Deadline was ${MOA_DEADLINE_LABEL}. Ask your block president`;
  if (days === 0) return `Deadline: today, ${MOA_DEADLINE_LABEL}`;
  return `Deadline: ${MOA_DEADLINE_LABEL} · ${days} day${days === 1 ? "" : "s"} left`;
}

const isMoa = (item) => /^memorandum of agreement/i.test(item.title);

// Step 2 (editing the MoA and sending it to the company for review) leaves no trace in the app, so the student ticks it
// off themselves. It is remembered in this browser only; it is a convenience, never the source of truth.
const flagKey = (userId) => `ojt-moa-sent-${userId}`;
const readFlag = (userId) => {
  try {
    return localStorage.getItem(flagKey(userId)) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (userId, on) => {
  try {
    if (on) localStorage.setItem(flagKey(userId), "1");
    else localStorage.removeItem(flagKey(userId));
  } catch {
    // private mode: the tick just will not stick
  }
};

const list = (names) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// Works out which step the student is on from their companies and their MoA upload.
function progressOf({ items, companies, userId }) {
  const companyTask = items.find((i) => i.kind === "companies");
  const moa = items.find(isMoa);
  const moaStatus = moa?.submission?.status;
  const moaSent = moaStatus === "submitted" || moaStatus === "approved";
  const accepted = companies.filter((c) => c.response === "accepted");
  const applied = companies.filter((c) => c.applied);

  const one = accepted.length > 0 || moaSent;
  const two = moaSent || (one && readFlag(userId));
  const three = moaSent;
  const current = !one ? 1 : !two ? 2 : !three ? 3 : 4;
  return { companyTask, moa, moaStatus, accepted, applied, one, two, three, current };
}

export function roadmap({ items, companies, userId, go, rerender }) {
  const p = progressOf({ items, companies, userId });

  const detail1 = p.accepted.length
    ? `Accepted by ${list(p.accepted.map((c) => c.name))}.`
    : p.applied.length
      ? `${p.applied.length} letter${p.applied.length === 1 ? "" : "s"} sent. Waiting for a reply.`
      : companies.length
        ? "Tick “I already applied here” on a company once its letter is sent."
        : "Start by adding the companies you will send letters to.";
  const detail3 =
    p.moaStatus === "approved"
      ? "Approved by your adviser."
      : p.moaStatus === "submitted"
        ? "Submitted. Waiting for your adviser."
        : p.moaStatus === "rejected"
          ? "Sent back. Read the note and upload it again."
          : "";

  const steps = [
    {
      title: "Send your letter of intent",
      text: "Send a request letter and your resume to the companies you want. The letter is noted by the Head of the BUCS IT Department. Then wait for a company to accept you.",
      detail: detail1,
      action: p.companyTask && {
        label: companies.length ? "Open my companies" : "Add a company",
        run: () => go(p.companyTask.id),
      },
    },
    {
      title: "Edit the MoA template",
      text: "Once a company accepts you, download the template and fill in the highlighted parts: the company’s name and address, its authorized representative and position, and a witness. Send it to them for review only. Do not ask them to sign it yet.",
      tag: MOA_TEMPLATE_URL ? "" : "Template coming soon",
      link: MOA_TEMPLATE_URL && { label: "Download the template", href: MOA_TEMPLATE_URL },
      detail: p.two && !p.three ? "Marked as sent for review." : "",
      action: p.current === 2 && {
        label: "I sent it for review",
        run: () => {
          writeFlag(userId, true);
          rerender();
        },
      },
      undo: p.two &&
        !p.three &&
        readFlag(userId) && {
          label: "Not yet",
          run: () => {
            writeFlag(userId, false);
            rerender();
          },
        },
    },
    {
      title: "Submit the reviewed MoA",
      text: "When the company is happy with the edited MoA, upload it here. Your block president sends everyone's MoAs to the Dean's Office together.",
      tag: p.three ? "" : deadlineTag(),
      detail: detail3,
      action: p.moa?.available && p.current === 3 && { label: "Upload my MoA", run: () => go(p.moa.id) },
    },
    {
      title: "Prepare your other documents",
      text: "While the rest of the block finishes their MoAs, work on your other documents. Details and templates will be posted here soon.",
      tag: "Details coming soon",
      detail: "",
    },
  ].map((step, i) => ({
    ...step,
    n: i + 1,
    state: i + 1 < p.current ? "done" : i + 1 === p.current ? "current" : "next",
  }));

  const pill = (state) =>
    state === "done"
      ? h("span", { className: "pill approved" }, icon("check", 13), "Done")
      : state === "current"
        ? h("span", { className: "pill solid" }, icon("pin", 13), "You are here")
        : h("span", { className: "pill" }, "Up next");

  const card = (s) =>
    h(
      "li",
      { className: `rm-step ${s.state}`, "aria-current": s.state === "current" ? "step" : undefined },
      h(
        "div",
        { className: "rm-top" },
        h("span", { className: "rm-num" }, s.state === "done" ? icon("check", 16) : String(s.n)),
        pill(s.state),
      ),
      h("h3", {}, s.title),
      h("p", { className: "rm-text" }, s.text),
      s.tag && h("span", { className: "rm-tag" }, s.tag),
      s.detail && h("p", { className: "rm-detail" }, s.detail),
      s.link &&
        h(
          "a",
          { className: "btn outline sm", href: s.link.href, download: "" }, // a download: the site's security header blocks the in-browser PDF viewer
          icon("download", 15),
          s.link.label,
        ),
      s.action &&
        h(
          "button",
          { type: "button", className: `btn sm${s.state === "current" ? "" : " outline"}`, onclick: s.action.run },
          s.action.label,
        ),
      s.undo && h("button", { type: "button", className: "btn link", onclick: s.undo.run }, s.undo.label),
    );

  const section = h(
    "section",
    { className: "card roadmap", id: "roadmap", "aria-labelledby": "roadmap-title" },
    h(
      "div",
      { className: "rm-head" },
      h("h2", { id: "roadmap-title" }, "Your OJT roadmap"),
      h(
        "p",
        {},
        "Four steps, in order. The whole block’s documents go to OSAS in one batch, so a step done early still waits for everyone.",
      ),
    ),
    h("ol", { className: "rm-steps" }, ...steps.map(card)),
  );

  return { section, current: steps[p.current - 1] };
}

const DATES = [
  [
    "Oct 28, 2026",
    "Deadline to submit your reviewed MoA (step 3). Your block president takes everyone’s MoAs to the Dean’s Office together.",
  ],
  [
    "Nov 30, 2026",
    "No company yet? Apply to a BU office (ICTO, an admin office or health services). No MoA is needed there.",
  ],
  ["Dec 15, 2026", "The latest every MoA must be settled. Aim for the end of November."],
  ["Jan 2027", "OJT starts, possibly February depending on OSAS and your travel order. 486 hours, about 3 months."],
];
const REMINDERS = [
  "Send MoA drafts to companies unsigned. They are for checking first.",
  "Never go to BU legal yourself. MoAs always go through your block president and the Dean’s Office, and legal takes about 3 to 4 weeks.",
  "Your company must give you a mentor and a real workspace. Avoid companies with a pending issue with BU.",
  "One late student delays the whole batch, so please keep up with your block president.",
];

export function guideAside() {
  return h(
    "aside",
    { className: "guide", "aria-label": "Good to know" },
    h(
      "section",
      { className: "card" },
      h("h2", {}, "Key dates"),
      h(
        "ul",
        { className: "guide-dates" },
        ...DATES.map(([when, what]) => h("li", {}, h("b", {}, when), h("span", {}, what))),
      ),
    ),
    h(
      "section",
      { className: "card" },
      h("h2", {}, "Good to know"),
      h("ul", { className: "guide-list" }, ...REMINDERS.map((r) => h("li", {}, icon("check", 15), h("span", {}, r)))),
    ),
  );
}
