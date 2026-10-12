import { api, h, icon } from "/common.js";

const params = new URLSearchParams(location.search);
const card = document.querySelector(".auth-card");
const seg = document.getElementById("seg");
const notice = document.getElementById("notice");
const screens = Object.fromEntries(
  ["login", "register", "forgot", "sent", "reset"].map((id) => [id, document.getElementById(id)]),
);

// ---------- Screen switching ----------

function go(name) {
  for (const [id, el] of Object.entries(screens)) el.hidden = id !== name;
  seg.hidden = name !== "login" && name !== "register";
  for (const tab of seg.querySelectorAll("button")) {
    const on = tab.dataset.go === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  document.title = `${{ login: "Log in", register: "Create account", forgot: "Reset password", sent: "Check your inbox", reset: "New password" }[name]} · BSIT 4C OJT Checklist`;
  screens[name].querySelector("input")?.focus({ preventScroll: true });
}

for (const btn of document.querySelectorAll("[data-go]")) btn.addEventListener("click", () => go(btn.dataset.go));

function say(kind, text) {
  notice.hidden = !text;
  notice.className = `notice ${kind}`;
  notice.replaceChildren(icon(kind === "ok" ? "check" : "alert"), text);
}

// ---------- Input niceties: leading icon + show/hide password ----------

for (const wrap of document.querySelectorAll(".input")) {
  const input = wrap.querySelector("input");
  wrap.prepend(icon(wrap.dataset.icon, 18));
  if ("toggle" in wrap.dataset) {
    const toggle = h(
      "button",
      { type: "button", className: "pw-toggle", "aria-label": "Show password" },
      icon("eye", 18),
    );
    toggle.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      toggle.replaceChildren(icon(reveal ? "eyeOff" : "eye", 18));
      toggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
    });
    wrap.append(toggle);
  }
}

// ---------- Password strength + requirement hints ----------

function strength(pw) {
  if (!pw) return { level: 0, label: "Choose a password" };
  if (pw.length < 8) return { level: 1, label: "Too short" };
  const extras = [pw.length >= 12, /[a-z]/.test(pw) && /[A-Z]/.test(pw), /\d/.test(pw), /[^A-Za-z0-9]/.test(pw)];
  const points = extras.filter(Boolean).length;
  const level = points >= 4 ? 4 : points >= 2 ? 3 : 2;
  return { level, label: ["", "", "Okay", "Good", "Strong"][level] };
}

function wireStrength(form) {
  const meter = form.querySelector("[data-strength]");
  const hints = form.querySelector("[data-hints]");
  if (!meter) return () => {};
  const pw = form.elements.password;
  const confirm = form.elements.confirm;

  const update = () => {
    const s = strength(pw.value);
    meter.dataset.level = s.level;
    meter.querySelector("span").textContent = s.label;
    const rows = [
      [pw.value.length >= 8, "At least 8 characters"],
      [confirm.value !== "" && pw.value === confirm.value, "Passwords match"],
    ];
    hints.replaceChildren(
      ...rows.map(([ok, text]) => h("li", { className: ok ? "ok" : "" }, icon(ok ? "check" : "x", 14), text)),
    );
  };
  pw.addEventListener("input", update);
  confirm.addEventListener("input", update);
  update();
  return update;
}

// ---------- Submit plumbing ----------

function problem(form, text, field) {
  const msg = form.querySelector(".msg");
  msg.textContent = text;
  msg.className = "msg err";
  card.classList.remove("shake");
  void card.offsetWidth; // restart the animation
  card.classList.add("shake");
  (typeof field === "string" ? form.elements[field] : field)?.focus();
}

// Runs fn with a spinner on the submit button; thrown errors appear in the form's message line.
function onSubmit(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = [...form.querySelectorAll("button[type=submit]")].find((b) => b.offsetParent);
    const msg = form.querySelector(".msg");
    msg.textContent = "";
    msg.className = "msg";
    button?.classList.add("loading");
    if (button) button.disabled = true;
    try {
      await fn(Object.fromEntries(new FormData(form)));
    } catch (err) {
      problem(form, err.message);
    } finally {
      button?.classList.remove("loading");
      if (button) button.disabled = false;
    }
  });
}

// ---------- Log in ----------

onSubmit(screens.login, async (v) => {
  await api("POST", "/api/login", v);
  location.href = "/app.html";
});

// ---------- Create account: step 1 (details) -> step 2 (account) ----------

const reg = screens.register;
const panes = [...reg.querySelectorAll("[data-pane]")];
const steps = [...reg.querySelectorAll(".stepper li")];
const updateRegStrength = wireStrength(reg);
let step = 1;

function setStep(n) {
  step = n;
  panes.forEach((p) => (p.hidden = Number(p.dataset.pane) !== n));
  steps.forEach((s) => {
    const k = Number(s.dataset.step);
    s.className = k < n ? "done" : k === n ? "current" : "";
    s.querySelector("i").replaceChildren(k < n ? icon("check", 13) : String(k));
  });
  reg.querySelector(".sub").textContent =
    n === 1 ? "It takes about a minute." : "Almost done. Set up how you will log in.";
  reg.querySelector(`[data-pane="${n}"] input`)?.focus({ preventScroll: true });
}

function nextStep() {
  const { fullName, studentId } = reg.elements;
  if (!fullName.value.trim()) return problem(reg, "Enter your full name.", fullName);
  if (!studentId.value.trim()) return problem(reg, "Enter your student ID.", studentId);
  reg.querySelector(".msg").textContent = "";
  setStep(2);
}

reg.querySelector("[data-next]").addEventListener("click", nextStep);
reg.querySelector("[data-back]").addEventListener("click", () => setStep(1));

reg.addEventListener(
  "submit",
  (e) => {
    if (step === 1) {
      e.preventDefault();
      e.stopImmediatePropagation();
      nextStep();
    }
  },
  { capture: true },
);

onSubmit(reg, async (v) => {
  if (!v.email.trim()) throw new Error("Enter your email address.");
  if (v.password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (v.password !== v.confirm) throw new Error("Passwords do not match.");
  if (!v.acceptPrivacy) throw new Error("Please read and accept the Privacy Notice to continue.");
  await api("POST", "/api/register", {
    acceptPrivacy: true,
    fullName: v.fullName.trim(),
    studentId: v.studentId.trim(),
    email: v.email,
    password: v.password,
  });
  location.href = "/app.html";
});

// ---------- Forgot / reset ----------

onSubmit(screens.forgot, async (v) => {
  await api("POST", "/api/password/forgot", v);
  go("sent");
});

wireStrength(screens.reset);
onSubmit(screens.reset, async (v) => {
  if (v.password.length < 8) throw new Error("Password must be at least 8 characters.");
  if (v.password !== v.confirm) throw new Error("Passwords do not match.");
  await api("POST", "/api/password/reset", { token: params.get("reset"), password: v.password });
  history.replaceState(null, "", "/");
  screens.reset.reset();
  go("login");
  say("ok", "Password updated. Log in with your new password.");
});

// ---------- Start ----------

async function start() {
  let verified = null;
  if (params.get("verify")) {
    try {
      await api("POST", "/api/verify", { token: params.get("verify") });
      verified = "1";
      say("ok", "Email verified. You can now submit requirements.");
    } catch (err) {
      verified = "0";
      say("err", err.message);
    }
  }

  if (params.get("reset")) return go("reset");

  // Already logged in? Skip straight to the app (carrying the verification result along).
  try {
    await api("GET", "/api/me");
    location.href = "/app.html" + (verified ? `?verified=${verified}` : "");
  } catch {
    go(params.get("mode") === "register" ? "register" : "login");
  }
}

start();
updateRegStrength();
setStep(1);
