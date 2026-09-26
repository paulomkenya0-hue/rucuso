// RUCUSO — front-end application logic (loaded as a classic script, so the
// top-level function declarations are what the inline onclick="..." handlers in
// index.html call).
//
// All application data comes from Supabase through window.RucusoData. The only
// things still kept in the browser are the student's own verified session and
// UI preferences — neither of which is shared data.
const API = window.RucusoAPI;
const D = window.RucusoData;
const DB = D.DB;

const STATUSES = ["New", "Under Review", "Assigned", "In Progress", "Awaiting Information", "Resolved", "Closed", "Rejected/Invalid"];
const STCLASS = { "New": "st-new", "Under Review": "st-review", "Assigned": "st-review", "In Progress": "st-progress", "Awaiting Information": "st-review", "Resolved": "st-resolved", "Closed": "st-closed", "Rejected/Invalid": "st-rejected" };
const PRCLASS = { "Low": "pr-low", "Medium": "pr-medium", "High": "pr-high", "Critical": "pr-critical" };
const TRACK_STEPS = ["New", "Under Review", "In Progress", "Resolved"];

const OTP_MESSAGES = {
  INVALID_PHONE: "Namba ya simu si sahihi. Tumia mfumo 07XXXXXXXX au +255XXXXXXXXX.",
  INVALID_REGISTRATION: "Namba ya usajili haijasajiliwa. Angalia kwa makini.",
  STUDENT_NOT_FOUND: "Samahani, namba hii ya usajili haijapatikana kwenye mfumo.",
  PHONE_MISMATCH: "Namba ya simu hailingiani na ile iliyorekodiwa kwa jina lako la usajili.",
  TOO_MANY_REQUESTS: "Umetuma maombi mengi ya msimu. Subiri muda mrefu kabla ya jaribu tena.",
  SMS_PROVIDER_NOT_CONFIGURED: "Huduma ya kutuma SMS haijawekwa bado. Tafadhali wasiliana na msimamizi wa mfumo.",
  SMS_SEND_FAILED: "Imeshindikana kutuma SMS. Tafadhali jaribu tena baadaye.",
  COULD_NOT_ISSUE: "Imeshindikana kutengeneza namba ya uthibitisho. Tafadhali jaribu tena.",
  NO_PENDING_CODE: "Hakuna namba ya uthibitisho iliyotumwa. Tafadhali tuma tena.",
  CODE_EXPIRED: "Namba ya uthibitisho imeisha muda wake. Tuma namba mpya.",
  TOO_MANY_ATTEMPTS: "Umejaribu mara nyingi mno. Tuma namba ya uthibitisho mpya.",
  INVALID_CODE_FORMAT: "Namba ya uthibitisho lazima iwe tarakimu 6.",
};

// ---------- small helpers ----------
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = label || "Inahifadhi...";
    btn.disabled = true;
  } else {
    if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
    btn.disabled = false;
  }
}
function fail(el, e) {
  const msg = D.errText(e);
  console.error(e);
  if (el) el.innerHTML = `<p class="err">${esc(msg)}</p>`;
  D.toast(msg, "err");
}
function sanitizeFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
}
function randomFolder() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) =>
    (Math.floor(Math.random() * 16) + (c === "x" ? 0 : 10)).toString(16));
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Edge Functions answer with a small JSON body even on failure; surface those
// codes as Kiswahili instead of a generic HTTP error.
async function functionErrorText(e) {
  const raw = (e && e.raw) || e;
  try {
    if (raw && raw.context && typeof raw.context.json === "function") {
      const body = await raw.context.json();
      if (body && body.error) {
        let msg = OTP_MESSAGES[body.error] || "Huduma ya uthibitisho imeshindikana. Tafadhali jaribu tena.";
        if (body.error === "WRONG_CODE" && typeof body.attempts_left === "number") {
          msg = `Namba ya uthibitisho si sahihi. Zilizobaki: ${body.attempts_left}.`;
        }
        return msg;
      }
    }
  } catch (_) { /* fall through */ }
  return D.errText(e);
}

// ---- Nav ----
// The public navigation is a list of page sections; the interactive tools
// (verification, feedback, tracking) are reached from the quick actions, the
// header and the footer rather than from a tab strip, because they are not
// destinations — they are tasks.
const PUBLIC_NAV = [
  ["home", "Nyumbani"],
  ["sec-about", "Kuhusu RUCUSO"],
  ["sec-services", "Huduma"],
  ["sec-leadership", "Uongozi"],
  ["sec-announcements", "Matangazo"],
  ["sec-documents", "Nyaraka"],
  ["sec-contact", "Mawasiliano"],
];
// Legacy staff views. They still work and are still RLS-protected, but they
// are superseded by the pages under /admin/ and are only ever offered to a
// signed-in staff member. Do not build new admin features here.
const STAFF_NAV = [
  ["dashboard", "Dashibodi"],
  ["issues", "Masuala"],
  ["reports", "Ripoti"],
  ["settings", "Mipangilio"],
];
const DRAWER_TOOLS = [
  ["submit", "Toa Maoni", "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"],
  ["verify", "Thibitisha utambulisho", "M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z"],
  ["track", "Fuatilia taarifa", "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3"],
];
const DRAWER_STAFF = [
  ["dashboard", "Dashibodi", "/admin/dashboard/"],
  ["issues", "Maoni &amp; Malalamiko", "/admin/feedback/"],
  ["reports", "Ripoti", "/admin/reports/"],
  ["settings", "Mipangilio", "/admin/settings/"],
];

let currentView = "home";
let navigationVersion = 0;
let verifyTarget = { preset: null };

function navIcon(path) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
}

function renderTabs() {
  const desk = document.getElementById("tabs");
  const draw = document.getElementById("drawerTabs");
  if (desk) desk.innerHTML = "";
  if (draw) draw.innerHTML = "";

  PUBLIC_NAV.forEach(([id, label]) => {
    if (desk) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#" + id;
      a.textContent = label;
      a.dataset.target = id;
      a.addEventListener("click", (e) => { e.preventDefault(); closeDrawer(false); go(id); });
      li.appendChild(a);
      desk.appendChild(li);
    }
    if (draw) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "drawer__link";
      b.dataset.target = id;
      b.innerHTML = navIcon(id === "home" ? "M3 10l9-7 9 7v10a2 2 0 01-2 2H5a2 2 0 01-2-2z" : "M4 6h16M4 12h16M4 18h10") + "<span>" + label + "</span>";
      b.addEventListener("click", () => { closeDrawer(false); go(id); });
      li.appendChild(b);
      draw.appendChild(li);
    }
  });

  // Student tools: only in the drawer, they are actions not sections.
  const tools = document.getElementById("drawerTools");
  if (tools) {
    tools.innerHTML = DRAWER_TOOLS.map(([id, label, path], i) =>
      '<button type="button" class="drawer__link' + (i === 0 ? " drawer__link--cta" : "") + '" data-target="' + id + '">'
      + navIcon(path) + "<span>" + label + "</span></button>").join("");
    tools.querySelectorAll("[data-target]").forEach((b) =>
      b.addEventListener("click", () => { closeDrawer(false); go(b.dataset.target); }));
  }

  // Staff links appear only for a signed-in staff member, and point at the
  // real /admin/ pages rather than at the legacy views.
  const staffWrap = document.getElementById("drawerStaff");
  const staffLinks = document.getElementById("drawerStaffLinks");
  if (staffWrap && staffLinks) {
    staffLinks.innerHTML = DRAWER_STAFF.map(([, label, href]) =>
      '<a class="drawer__link" href="' + href + '">' + navIcon("M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z") + "<span>" + label + "</span></a>").join("");
    staffWrap.hidden = !DB.session;
  }

  const who = document.getElementById("loginState");
  if (who) who.textContent = DB.session ? "Umeingia kama " + DB.session.name : "";

  markActiveNav();
}

// Keeps the header, the drawer and the section anchors in sync with whatever
// is on screen, whichever way the visitor got there (click, back button,
// deep link, scroll).
function markActiveNav() {
  const target = currentView === "home" ? (activeSection() || "home") : currentView;
  document.querySelectorAll("[data-target]").forEach((el) => {
    const on = el.dataset.target === target;
    if (el.tagName === "A") {
      if (on) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
    if (el.classList.contains("drawer__link")) el.setAttribute("aria-current", on ? "true" : "false");
  });
}

function activeSection() {
  const line = window.scrollY + (parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h"), 10) || 64) + 24;
  let found = "home";
  PUBLIC_NAV.forEach(([id]) => {
    if (id === "home" || id === "sec-contact") return;
    const el = document.getElementById(id);
    if (el && el.offsetTop <= line) found = id;
  });
  // the last section needs the bottom of the page, not just its top edge
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 4) found = "sec-contact";
  return found;
}

let scrollTicking = false;
window.addEventListener("scroll", () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    if (currentView === "home") markActiveNav();
  });
}, { passive: true });

function goSection(id) {
  closeDrawer(false);
  const el = document.getElementById(id);
  if (!el) return;
  navigationVersion++;
  // A section link pressed while a tool view is open: return to the page first.
  if (currentView !== "home") {
    currentView = "home";
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    const home = document.getElementById("homeview");
    if (home) home.classList.add("active");
    renderTabs();
  }
  el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  if (history.replaceState) history.replaceState(null, "", "#" + id);
  // move focus so keyboard and screen-reader users land where the page did
  el.setAttribute("tabindex", "-1");
  setTimeout(() => el.focus({ preventScroll: true }), prefersReducedMotion() ? 0 : 420);
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function go(id, presetType) {
  navigationVersion++;
  if (STAFF_NAV.some(([s]) => s === id) && !DB.session) {
    // The legacy staff views have no in-page login form — send an
    // unauthenticated visitor to the real portal instead of doing nothing.
    location.href = "/admin/login/";
    return;
  }
  if (id === "submit" && !DB.studentSession) { verifyTarget = { preset: presetType || null }; id = "verify"; }
  if (id.indexOf("sec-") === 0) { goSection(id); return; }

  const previousView = currentView;
  currentView = id;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = document.getElementById(id === "home" ? "homeview" : "view-" + id);
  if (!target) { goSection("sec-about"); return; }
  target.classList.add("active");
  if (id !== "home") {
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  } else if (previousView !== "home") {
    const heading = document.getElementById("heroTitle");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }
  renderTabs();
  onEnterView(id, presetType);

  window.scrollTo({ top: 0, behavior: "instant" });
  if (history.replaceState) history.replaceState(null, "", id === "home" ? location.pathname : "#" + id);
}

// Per-view initialisation, split out of go() so a section scroll never has to
// run it.
function onEnterView(id, presetType) {
  if (id === "home") { renderHomeSections(); return; }

  if (id === "verify") {
    ["ver-step1", "ver-step2", "ver-step3"].forEach((s, i) =>
      document.getElementById(s).classList.toggle("hidden", i !== 0));
    document.getElementById("ver_reg").value = "";
    document.getElementById("ver1_msg").innerHTML = "";
    document.getElementById("ver2_msg").textContent = "";
    document.getElementById("ver3_msg").textContent = "";
    setVerMark("idle");
  }
  if (id === "submit") {
    populateCategories();
    newCaptcha();
    fbReset();
    document.getElementById("successCard").classList.add("hidden");
    document.getElementById("regLookupMsg").textContent = "";
    document.getElementById("f_name").readOnly = false;
    if (DB.studentSession) {
      const s = DB.studentSession;
      document.getElementById("verifiedBanner").classList.remove("hidden");
      document.getElementById("vb_name").textContent = s.name;
      document.getElementById("vb_reg").textContent = s.reg;
      const otpNotice = document.getElementById("otpBypassNotice");
      if (otpNotice) otpNotice.classList.toggle("hidden", s.otp_verified !== false);
      document.getElementById("f_reg").value = s.reg;
      document.getElementById("f_reg").readOnly = true;
      document.getElementById("f_name").value = s.name;
      document.getElementById("f_name").readOnly = true;
      document.getElementById("f_phone").value = s.phone || "";
      if (DB.programmes.length) document.getElementById("f_prog_sel").value = s.programme || "";
      else document.getElementById("f_prog").value = s.programme || "";
    } else {
      document.getElementById("verifiedBanner").classList.add("hidden");
    }
    document.getElementById("agreeChk").checked = false;
    document.getElementById("formArea").classList.add("hidden");
    if (presetType) setTimeout(() => {
      document.getElementById("agreeChk").checked = true;
      document.getElementById("formArea").classList.remove("hidden");
      fbReset();
      selectType(presetType);
    }, 0);
  }
  if (id === "track") {
    const out = document.getElementById("trackResult");
    if (out) out.innerHTML = "";
  }
  if (id === "dashboard") renderDashboard();
  if (id === "issues") renderIssues();
  if (id === "reports") { /* generated on demand */ }
  if (id === "settings") renderSettings();
}

// The homepage renders all of its sections from one Supabase read, so scroll
// navigation never has to fetch anything.
let homeRendered = false;
function renderHomeSections() {
  renderHeroStats();
  renderContacts();
  renderServices();
  renderAnnouncements();
  renderLeadership();
  renderDocuments();
  homeRendered = true;
}

document.addEventListener("change", (e) => {
  if (e.target.id === "f_anon") {
    document.getElementById("identBlock").classList.toggle("hidden", e.target.checked);
  }
});

const heslbVerifyForm = document.getElementById("heslbVerifyForm");
if (heslbVerifyForm) heslbVerifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("heslbVerifyButton");
  const message = document.getElementById("heslbVerifyMessage");
  const success = document.getElementById("heslbVerified");
  const indexNumber = document.getElementById("heslbIndex").value.trim();
  const phone = document.getElementById("heslbPhone").value.trim();
  message.textContent = "";
  success.classList.add("hidden");
  button.disabled = true;
  button.textContent = "Inathibitisha...";
  try {
    const verified = await API.verifyHeslbBeneficiary(indexNumber, phone);
    if (!verified) throw new Error("verification_failed");
    success.classList.remove("hidden");
    success.focus({ preventScroll: true });
  } catch (_) {
    message.textContent = "Taarifa hazijaweza kuthibitishwa. Hakiki namba zako au wasiliana na Wizara ya Mikopo na Uwezeshaji.";
  } finally {
    button.disabled = false;
    button.textContent = "Thibitisha";
  }
});

// ---------- Mobile drawer ----------
// The panel is display:none until .active lands, and focus() on a
// display:none element is a silent no-op — so the class has to be applied
// first and the focus moved on the next frame.
let drawerOpener = null;
function openDrawer(trigger) {
  const d = document.getElementById("drawer");
  const h = document.getElementById("hamburger");
  if (!d || !d.hidden) return;
  drawerOpener = trigger || document.getElementById("hamburger");
  d.hidden = false;
  requestAnimationFrame(() => {
    d.classList.add("active");
    requestAnimationFrame(() => {
      const first = d.querySelector(".drawer__link");
      if (first) first.focus();
    });
  });
  document.body.classList.add("drawer-open");
  if (h) h.setAttribute("aria-expanded", "true");
}
function closeDrawer(returnFocus) {
  const d = document.getElementById("drawer");
  const h = document.getElementById("hamburger");
  if (!d || d.hidden) return;
  d.classList.remove("active");
  document.body.classList.remove("drawer-open");
  if (h) h.setAttribute("aria-expanded", "false");
  // Focus must leave the panel before it is display:none, or it drops to
  // <body> and the next Tab starts from the top of the page.
  if (returnFocus !== false) {
    const back = drawerOpener && document.body.contains(drawerOpener) ? drawerOpener : h;
    if (back) back.focus();
  }
  drawerOpener = null;
  const done = () => { d.hidden = true; };
  if (prefersReducedMotion()) done();
  else setTimeout(done, 200);
}
function drawerIsOpen() {
  const d = document.getElementById("drawer");
  return !!(d && !d.hidden);
}

function initDrawer() {
  const h = document.getElementById("hamburger");
  const d = document.getElementById("drawer");
  if (h) h.addEventListener("click", (e) => (drawerIsOpen() ? closeDrawer() : openDrawer(e.currentTarget)));
  if (d) d.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", () => closeDrawer()));
}

// Focus restoration for modals, following the same pattern the drawer uses
// with drawerOpener: remember what opened the sheet so both Escape and the
// close button put the user back where they were.
function rememberOpener(bg) {
  if (!bg) return;
  const a = document.activeElement;
  bg._opener = a && a !== document.body ? a : null;
}
function restoreOpener(bg) {
  const o = bg && bg._opener;
  if (bg) bg._opener = null;
  if (o && document.body.contains(o)) { o.focus(); return true; }
  // the opener was re-rendered away: fall back to the top of the page rather
  // than leaving focus stranded on a node that is about to be display:none
  const main = document.getElementById("main");
  if (main) {
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus();
  }
  return false;
}

// Esc closes the topmost transient surface, and focus returns to whatever
// opened it. Without this a keyboard user can get trapped behind an overlay.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const ai = document.getElementById("aiModalBg");
  if (ai && ai.classList.contains("active")) { closeAI(); return; }
  const open = ["issueModalBg", "leaderModalBg", "serviceModalBg", "annModalBg"]
    .map((id) => document.getElementById(id))
    .find((el) => el && el.classList.contains("active"));
  // go through closeModal so the body lock, the backdrop handler and focus all
  // get cleaned up; dropping the class alone left body.modal-open behind
  if (open) { closeModal(open.id); return; }
  if (drawerIsOpen()) closeDrawer();
});

// ---------- Small view helpers ----------
// One place to change the verification card's icon/colour per state, so the
// states are consistent instead of three hand-rolled <div>s.
function setVerMark(state) {
  const m = document.getElementById("verMark");
  if (!m) return;
  m.className = "vcard__mark vcard__mark--" + state;
  const paths = {
    idle: "M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z|M9 12l2 2 4-4",
    wait: "M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z",
    ok: "M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z|M9 12l2 2 4-4",
    err: "M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z|M12 8v5M12 16h.01",
  };
  m.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + (paths[state] || paths.idle).split("|")
      .map((d) => '<path d="' + d + '"/>').join("") + "</svg>";
}

// A loading placeholder that matches the shape of the content it replaces, so
// the layout does not jump when the data lands.
function skeleton(count, cls) {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += '<div class="card" style="margin:0"><div class="skeleton ' + (cls || "skel-card") + '"></div></div>';
  }
  return out;
}
function skeletonLines(host, n) {
  if (host) host.innerHTML = skeleton(n, "skel-card");
}
function stateBox(kind, title, body, iconPath) {
  return '<div class="statebox' + (kind ? " statebox--" + kind : "") + '">'
    + '<div class="statebox__icon">' + navIcon(iconPath || "M12 8v4M12 16h.01M12 3l9 16H3z") + "</div>"
    + (title ? '<p class="statebox__title">' + esc(title) + "</p>" : "")
    + "<p>" + body + "</p></div>";
}

// ---------- Homepage chrome ----------
function renderHeroStats() {
  const n = {
    heroLeaders: DB.leaders.filter((l) => l.active && l.name).length,
    heroServices: DB.services.filter((s) => s.active).length,
    heroAnnouncements: DB.announcements.length,
    heroMinistries: DB.ministries.filter((m) => m.active).length,
  };
  Object.keys(n).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n[id];
  });
}

function renderContacts() {
  const phone = DB.contacts.phone || "";
  const email = DB.contacts.email || "";
  const year = DB.acadYear || "2026/2027";

  const set = (id, value, href, txt) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!value) { el.textContent = txt; el.removeAttribute("href"); el.className = "footercontact__none"; return; }
    el.textContent = value;
    if (href) el.href = href;
    el.className = "";
  };
  set("footPhone", phone, "tel:" + phone.replace(/\s+/g, ""), "Haijawekwa bado");
  set("footEmail", email, "mailto:" + email, "Haijawekwa bado");
  set("contactPhone", phone, "tel:" + phone.replace(/\s+/g, ""), "Msimamizi wa mfumo bado hajaweka namba.");
  set("contactEmail", email, "mailto:" + email, "Msimamizi wa mfumo bado hajaweka barua pepe.");
  set("utilPhone", phone, "tel:" + phone.replace(/\s+/g, ""), "—");
  set("utilEmail", email, "mailto:" + email, "—");
  const pw = document.getElementById("utilPhoneWrap");
  const ew = document.getElementById("utilEmailWrap");
  if (pw) pw.hidden = !phone;
  if (ew) ew.hidden = !email;

  const y = document.getElementById("utilYear");
  if (y) y.textContent = year;
  const f = document.getElementById("footAcadYear");
  if (f) f.textContent = "Mwaka wa Masomo " + year;
  const fy = document.getElementById("footYear");
  if (fy) fy.textContent = String(new Date().getFullYear());
}

// ---------- Feedback wizard ----------
const FB_STEPS = 5;
let fbStep = 1;

// Every field the wizard owns. Listed by prefix so a new f_* input joins the
// reset automatically. f_anon and identBlock are the identity gate: unchecking
// it must reveal the identity fields again, not leave them hidden.
const FB_FIELDS = ["f_type", "f_category", "f_title", "f_desc", "f_date", "f_loc",
  "f_solution", "f_rating", "f_priority", "f_file", "f_anon", "f_reg", "f_name",
  "f_prog", "f_prog_sel", "f_year", "f_phone", "f_email"];

function fbReset() {
  fbStep = 1;

  FB_FIELDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox" || el.type === "radio") el.checked = false;
    else el.value = "";   // also correct for <input type="file"> and for
                          // selects, whose first option is the empty one
  });

  // the identity block follows the anonymous checkbox
  const ident = document.getElementById("identBlock");
  if (ident) ident.classList.remove("hidden");

  // clear validation and success leftovers so a reopened form starts clean
  ["fbErr1", "fbErr2", "fbErr3", "fbErr4", "submitErr"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
  const summary = document.getElementById("submitSummary");
  if (summary) summary.innerHTML = "";

  // #agreeChk is deliberately left alone: onEnterView owns the consent gate,
  // and the preset flow ticks it before calling this.

  document.querySelectorAll("#fstep-1 .choice").forEach((b) => b.setAttribute("aria-pressed", "false"));
  fbPaint();
}

function fbPaint() {
  for (let i = 1; i <= FB_STEPS; i++) {
    const step = document.getElementById("fstep-" + i);
    if (step) step.classList.toggle("active", i === fbStep);
    const dot = document.querySelector('.stepper__item[data-step="' + i + '"]');
    if (dot) {
      dot.setAttribute("data-state", i === fbStep ? "active" : i < fbStep ? "done" : "todo");
      const d = dot.querySelector(".stepper__dot");
      if (d) d.textContent = i < fbStep ? "✓" : String(i);
    }
  }
  // A step can only be jumped back to once it has been answered, so the
  // overlay buttons are disabled (and out of the tab order) until then.
  document.querySelectorAll("#stepperJumps [data-goto]").forEach((b) => {
    const n = Number(b.dataset.goto);
    b.disabled = n > fbStep;
  });
  const prev = document.getElementById("fstepPrev");
  const next = document.getElementById("fstepNext");
  const sub = document.getElementById("fstepSubmit");
  if (prev) prev.hidden = fbStep === 1;
  if (next) next.hidden = fbStep === FB_STEPS;
  if (sub) sub.hidden = fbStep !== FB_STEPS;
  if (fbStep === FB_STEPS) fbSummary();
}

function selectType(type) {
  const sel = document.getElementById("f_type");
  if (sel) sel.value = type;
  document.querySelectorAll("#fstep-1 .choice").forEach((b) =>
    b.setAttribute("aria-pressed", b.dataset.type === type ? "true" : "false"));
}

// Per-step validation, so a visitor is told what is missing while they are
// still looking at the field. submitFeedback() remains the final gate.
function fbValidate(step) {
  const say = (msg) => {
    const box = document.getElementById(step === 5 ? "submitErr" : "fbErr" + step);
    if (box) box.textContent = msg;
    return false;
  };
  if (step === 1) {
    const sel = document.getElementById("f_type");
    if (!sel || !sel.value) return say("Chagua aina ya maoni ili kuendelea.");
  }
  if (step === 3) {
    if (!document.getElementById("f_title").value.trim()) return say("Andika kichwa fupi cha maoni yako.");
    if (document.getElementById("f_desc").value.trim().length < 10) return say("Eleza zaidi kidogo ili tuweze kukusaidia vizuri.");
  }
  if (step === 4) {
    // The identity block is on this step, so that is where it is checked —
    // the summary step is too late to be useful feedback.
    if (document.getElementById("f_anon").checked) return true;
    const name = document.getElementById("f_name").value.trim();
    const reg = document.getElementById("f_reg").value.trim();
    if (!name || !reg) return say("Weka jina lako na namba ya usajili, au chagua 'wasilisha bila jina'.");
  }
  if (step === 5) {
    if (document.getElementById("captchaAns").value.trim() === "") return say("Jibu swali la uthibitisho ulio hapa chini.");
  }
  const box = document.getElementById(step === 5 ? "submitErr" : "fbErr" + step);
  if (box) box.textContent = "";
  return true;
}

function fbNext() {
  if (!fbValidate(fbStep)) return;
  if (fbStep < FB_STEPS) { fbStep++; fbPaint(); focusStep(); }
}
function fbPrev() {
  if (fbStep > 1) { fbStep--; fbPaint(); focusStep(); }
}
function focusStep() {
  const q = document.querySelector(".fstep.active .fstep__q");
  if (q) {
    const card = q.closest(".fstep");
    if (card) card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
  }
}

function fbSummary() {
  const el = document.getElementById("submitSummary");
  if (!el) return;
  const v = (id) => (document.getElementById(id) || {}).value || "";
  const anon = document.getElementById("f_anon").checked;
  const progSel = document.getElementById("f_prog_sel");
  const rows = [
    ["Aina", v("f_type")],
    ["Kundi", (document.getElementById("f_category").selectedOptions[0] || {}).textContent],
    ["Kichwa", v("f_title")],
    ["Maelezo", v("f_desc")],
    ["Eneo", v("f_loc") || "—"],
    ["Mapendekezo", v("f_solution") || "—"],
    ["Kuridhika", v("f_rating") ? v("f_rating") + " / 5" : "—"],
    ["Kipaumbele", v("f_priority")],
    ["Utambulisho", anon ? "Bila jina" : [v("f_name"), v("f_reg")].filter(Boolean).join(" · ") || "—"],
    ["Programu", anon ? "—" : (progSel && !progSel.classList.contains("hidden") ? progSel.value : v("f_prog")) || "—"],
  ];
  el.innerHTML = rows.map(([k, val]) =>
    '<div class="summarylist__row"><dt>' + esc(k) + '</dt><dd>' + esc(val) + "</dd></div>").join("");
}

function initWizard() {
  document.querySelectorAll("#fstep-1 .choice").forEach((b) =>
    b.addEventListener("click", () => { selectType(b.dataset.type); fbValidate(1); }));
  document.querySelectorAll("#stepperJumps [data-goto]").forEach((b) =>
    b.addEventListener("click", () => { fbStep = Number(b.dataset.goto); fbPaint(); focusStep(); }));
  // Enter advances instead of submitting a half-finished report.
  const form = document.getElementById("formArea");
  if (form) form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT" && fbStep < FB_STEPS && e.target.type !== "file") {
      e.preventDefault();
      fbNext();
    }
  });
}


// ---------- Categories / programmes on the submission form ----------
function populateCategories() {
  const sel = document.getElementById("f_category");
  sel.innerHTML = "";
  DB.categories.filter((c) => c.active !== false).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  });
  const pInput = document.getElementById("f_prog");
  const pSel = document.getElementById("f_prog_sel");
  if (DB.programmes.length) {
    pSel.innerHTML = DB.programmes.map((p) => `<option>${esc(p.name)}</option>`).join("");
    pSel.classList.remove("hidden");
    pInput.classList.add("hidden");
  } else {
    pSel.classList.add("hidden");
    pInput.classList.remove("hidden");
  }
}

let regLookupTimer = null;
function lookupReg() {
  const reg = document.getElementById("f_reg").value.trim();
  const msg = document.getElementById("regLookupMsg");
  const nameInput = document.getElementById("f_name");
  clearTimeout(regLookupTimer);
  if (!reg) { msg.textContent = ""; nameInput.readOnly = false; return; }
  regLookupTimer = setTimeout(async () => {
    msg.textContent = "Inatafuta…";
    try {
      const match = await API.lookupStudent(reg);
      if (match && match.full_name) {
        nameInput.value = match.full_name;
        nameInput.readOnly = true;
        msg.innerHTML = `<span class="ok-msg">✓ Namba hii ipo kwenye database — jina limepatikana: ${esc(match.full_name)}</span>`;
      } else {
        nameInput.readOnly = false;
        msg.innerHTML = '<span class="err">Namba hii haipatikani kwenye database ya wanafunzi waliosajiliwa. Unaweza kuendelea kujaza jina mwenyewe.</span>';
      }
    } catch (e) {
      nameInput.readOnly = false;
      msg.innerHTML = `<span class="err">${esc(D.errText(e))}</span>`;
    }
  }, 350);
}

// ---------- Student verification: reg number -> phone -> OTP ----------
//
// REQUIRE_SMS_OTP: SMS delivery isn't wired to a live provider yet, so real
// OTP codes can't reach students right now. While this is false, step 2
// verifies the phone number already on file (via verify_student_identity,
// migration 006) instead of sending/checking an SMS code, and step 3 is
// skipped entirely. Flip this back to true the moment SMS is live — nothing
// else needs to change, sendOtp()/verifyOtp() below are untouched.
const REQUIRE_SMS_OTP = false;

let verifyMatch = null;
async function verifyStep1(ev) {
  const btn = ev && ev.currentTarget;
  const reg = document.getElementById("ver_reg").value.trim();
  const msg = document.getElementById("ver1_msg");
  if (!reg) {
    setVerMark("err");
    msg.innerHTML = '<p class="err">Tafadhali ingiza namba yako ya usajili.</p>';
    return;
  }
  setVerMark("wait");
  msg.innerHTML = '<p class="muted">Inathibitisha…</p>';
  busy(btn, true, "Inathibitisha...");
  try {
    const match = await API.lookupStudent(reg);
    if (!match) {
      setVerMark("err");
      msg.innerHTML = '<p class="err">Samahani, namba hii ya usajili haijapatikana kwenye mfumo.</p>'
        + '<div class="btnrow" style="margin-top:var(--sp-3);justify-content:flex-start">'
        + '<button class="btn btn--ghost btn--sm" onclick="verifyStep1(event)">Jaribu tena</button>'
        + '<button class="btn btn--ghost btn--sm" onclick="openAI()">Wasiliana na RUCUSO</button></div>';
      return;
    }
    verifyMatch = {
      reg, name: match.full_name,
      programme: match.programme || "", year: match.year_of_study || "",
    };
    setVerMark("ok");
    document.getElementById("ver_name").textContent = verifyMatch.name;
    document.getElementById("ver_prog").textContent = verifyMatch.programme || "—";
    document.getElementById("ver_year").textContent = verifyMatch.year ? "Mwaka wa " + verifyMatch.year : "—";
    document.getElementById("ver-step1").classList.add("hidden");
    document.getElementById("ver-step2").classList.remove("hidden");
    document.getElementById("ver2_msg").textContent = "";
    // Swap step-2's copy/button between "send OTP" and "confirm phone on
    // file" depending on REQUIRE_SMS_OTP, without touching the HTML.
    document.getElementById("ver2_hint").textContent = REQUIRE_SMS_OTP
      ? "Ingiza namba yako ya simu ya Tanzania (mfano 07XXXXXXXX au +255XXXXXXXXX)."
      : "Ingiza namba yako ya simu iliyosajiliwa RUCUSO (mfano 07XXXXXXXX au +255XXXXXXXXX).";
    const btn2 = document.getElementById("ver2_btn");
    btn2.textContent = REQUIRE_SMS_OTP ? "TUMA OTP" : "THIBITISHA";
    btn2.onclick = REQUIRE_SMS_OTP ? sendOtp : confirmPhoneOnFile;
  } catch (e) {
    setVerMark("err");
    msg.innerHTML = `<p class="err">${esc(D.errText(e))}</p>`;
  } finally {
    busy(btn, false);
  }
}

// Bypass path: reg number (step 1) + phone-on-file (step 2), no SMS involved.
// Session is marked otp_verified:false so the UI can show the disclosure
// banner, and so a future step can require real OTP before, say, letting a
// bypass session do something higher-stakes.
async function confirmPhoneOnFile(ev) {
  const btn = ev && ev.currentTarget;
  const norm = normalizeTzPhone(document.getElementById("ver_phone").value);
  const emsg = document.getElementById("ver2_msg");
  if (!norm) {
    setVerMark("err");
    emsg.textContent = "Namba ya simu si sahihi. Tumia mfumo 07XXXXXXXX au +255XXXXXXXXX.";
    return;
  }
  emsg.textContent = "";
  setVerMark("wait");
  busy(btn, true, "Inathibitisha...");
  try {
    const match = await API.verifyStudentIdentity(verifyMatch.reg, norm);
    if (!match) {
      setVerMark("err");
      emsg.textContent = "Namba ya usajili na namba ya simu hazilingani na kumbukumbu zetu.";
      return;
    }
    setVerMark("ok");
    DB.studentSession = {
      reg: verifyMatch.reg, name: match.full_name || verifyMatch.name,
      programme: match.programme || verifyMatch.programme, year: match.year_of_study || verifyMatch.year,
      phone: norm, verifiedAt: new Date().toISOString(), otp_verified: false,
    };
    D.saveStudentSession(DB.studentSession);
    await API.logPublicAction("Student Verification (Reg+Phone, OTP pending)", verifyMatch.reg + " — " + norm);
    go("submit", verifyTarget.preset);
  } catch (e) {
    emsg.textContent = await functionErrorText(e);
  } finally {
    busy(btn, false);
  }
}

function normalizeTzPhone(v) {
  v = String(v || "").replace(/[\s-]/g, "");
  if (/^\+255\d{9}$/.test(v)) return v;
  if (/^0\d{9}$/.test(v)) return "+255" + v.slice(1);
  if (/^255\d{9}$/.test(v)) return "+" + v;
  return null;
}

let otpTimer = null;
async function sendOtp(ev) {
  const btn = ev && ev.currentTarget;
  const norm = normalizeTzPhone(document.getElementById("ver_phone").value);
  const emsg = document.getElementById("ver2_msg");
  if (!norm) {
    emsg.textContent = "Namba ya simu si sahihi. Tumia mfumo 07XXXXXXXX au +255XXXXXXXXX.";
    return;
  }
  emsg.textContent = "";
  busy(btn, true, "Inatuma...");
  setVerMark("wait");
  try {
    await API.sendOtp(norm, verifyMatch.reg);
    document.getElementById("ver_phone_out").textContent = norm;
    document.getElementById("ver-step2").classList.add("hidden");
    document.getElementById("ver-step3").classList.remove("hidden");
    document.getElementById("ver3_msg").textContent = "";
    document.getElementById("ver_otp").value = "";
    // still "wait": the code has been sent and we are waiting for it
    setVerMark("wait");
    startResendTimer();
  } catch (e) {
    emsg.textContent = await functionErrorText(e);
    setVerMark("err");
  } finally {
    busy(btn, false);
  }
}

function startResendTimer() {
  const link = document.getElementById("resendLink");
  let secs = 60;
  link.style.pointerEvents = "none";
  link.style.opacity = ".5";
  link.textContent = "Tuma tena baada ya " + secs + "s";
  clearInterval(otpTimer);
  otpTimer = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(otpTimer);
      link.style.pointerEvents = "auto";
      link.style.opacity = "1";
      link.textContent = "Tuma tena OTP";
    } else {
      link.textContent = "Tuma tena baada ya " + secs + "s";
    }
  }, 1000);
}

async function verifyOtp(ev) {
  const btn = ev && ev.currentTarget;
  const code = document.getElementById("ver_otp").value.trim();
  const msg = document.getElementById("ver3_msg");
  if (!/^\d{6}$/.test(code)) { msg.textContent = "Namba ya uthibitisho lazima iwe tarakimu 6."; setVerMark("err"); return; }
  const phone = normalizeTzPhone(document.getElementById("ver_phone").value);
  busy(btn, true, "Inathibitisha...");
  setVerMark("wait");
  try {
    const res = await API.verifyOtp(phone, code);
    if (!res || !res.verified) { msg.textContent = "Namba ya uthibitisho si sahihi."; setVerMark("err"); return; }
    setVerMark("ok");
    DB.studentSession = {
      reg: verifyMatch.reg, name: res.full_name || verifyMatch.name,
      programme: verifyMatch.programme, year: verifyMatch.year,
      phone, verifiedAt: new Date().toISOString(),
    };
    D.saveStudentSession(DB.studentSession);
    await API.logPublicAction("Student Verification (OTP)", verifyMatch.reg + " — " + phone);
    go("submit", verifyTarget.preset);
  } catch (e) {
    msg.textContent = await functionErrorText(e);
    setVerMark("err");
  } finally {
    busy(btn, false);
  }
}

function studentLogout() {
  DB.studentSession = null;
  D.saveStudentSession(null);
  go("home");
}

// ---------- Submit ----------
let captchaAnswer = 0;
function newCaptcha() {
  const a = Math.floor(Math.random() * 8) + 1;
  const b = Math.floor(Math.random() * 8) + 1;
  captchaAnswer = a + b;
  document.getElementById("captchaLabel").textContent = `Quick check: what is ${a} + ${b}?`;
  document.getElementById("captchaAns").value = "";
}

async function submitFeedback(ev) {
  const err = document.getElementById("submitErr");
  const btn = ev && ev.currentTarget;
  err.textContent = "";
  const title = document.getElementById("f_title").value.trim();
  const desc = document.getElementById("f_desc").value.trim();
  if (!title || !desc) { err.textContent = "Kichwa na maelezo ya maoni yanahitajika."; return; }
  if (+document.getElementById("captchaAns").value !== captchaAnswer) {
    err.textContent = "Jibu la swali la uthibitisho si sahihi."; return;
  }
  const anon = document.getElementById("f_anon").checked;
  const name = document.getElementById("f_name").value.trim();
  const reg = document.getElementById("f_reg").value.trim();
  if (!anon && (!name || !reg)) {
    err.textContent = "Weka jina lako na namba ya usajili, au chagua 'wasilisha bila jina'."; return;
  }
  const progVal = DB.programmes.length
    ? document.getElementById("f_prog_sel").value
    : document.getElementById("f_prog").value;
  const rating = document.getElementById("f_rating").value;

  busy(btn, true, "Inatuma...");
  try {
    let attachment_url = null, attachment_name = null;
    const file = document.getElementById("f_file").files[0];
    if (file) {
      if (file.size > 1024 * 1024) { err.textContent = "Kiambatisho ni kubwa mno (upekee wa 1MB)."; return; }
      const path = `${randomFolder()}/${Date.now()}-${sanitizeFileName(file.name)}`;
      attachment_url = await API.uploadPrivateFile(API.BUCKETS.attachments, path, file);
      attachment_name = file.name;
    }
    const ref = await API.submitFeedback({
      p_submission_type: document.getElementById("f_type").value,
      p_title: title,
      p_description: desc,
      p_category_id: document.getElementById("f_category").value || null,
      p_incident_date: document.getElementById("f_date").value || null,
      p_location: document.getElementById("f_loc").value.trim() || null,
      p_suggested_solution: document.getElementById("f_solution").value.trim() || null,
      p_satisfaction_rating: rating ? Number(rating) : null,
      p_priority: document.getElementById("f_priority").value,
      p_is_anonymous: anon,
      // lookup_student() intentionally returns no id, so student_id stays null
      // and the identifying details are carried by the snapshot columns.
      p_student_id: null,
      p_student_name: anon ? null : name,
      p_student_reg: anon ? null : reg,
      p_student_programme: anon ? null : progVal,
      p_student_year: anon ? null : document.getElementById("f_year").value.trim(),
      p_student_phone: anon ? null : document.getElementById("f_phone").value.trim(),
      p_student_email: anon ? null : document.getElementById("f_email").value.trim(),
      p_ministry_id: null,
      p_attachment_url: attachment_url,
      p_attachment_name: attachment_name,
    });
    document.getElementById("refOut").textContent = ref;
    document.getElementById("successCard").classList.remove("hidden");
    document.getElementById("formArea").classList.add("hidden");
    document.getElementById("privacyGate").classList.add("hidden");
    ["f_title", "f_desc", "f_loc", "f_solution", "f_file"].forEach((id) => { document.getElementById(id).value = ""; });
    newCaptcha();
  } catch (e) {
    err.textContent = submitErrorText(e);
  } finally {
    busy(btn, false);
  }
}

function submitErrorText(e) {
  const raw = D.errText(e);
  if (/DUPLICATE_SUBMISSION/i.test(raw)) {
    return "Ripoti kama hii imetumwa hivi karibuni. Tafadhali subiri dakika chache, au ufuatilie ripoti yako iliyopo.";
  }
  if (/TITLE_REQUIRED/i.test(raw)) return "Subject is required.";
  if (/DESCRIPTION_REQUIRED/i.test(raw)) return "Description is required.";
  if (/INVALID_(TYPE|PRIORITY|RATING)/i.test(raw)) return "One of the selected options is not valid. Please review the form and try again.";
  return raw;
}

// ---------- Track ----------
async function doTrack(ev) {
  const btn = ev && ev.currentTarget;
  const ref = document.getElementById("trackRef").value.trim().toUpperCase();
  const out = document.getElementById("trackResult");
  if (!ref) {
    out.innerHTML = stateBox("error", "Reference number inahitajika",
      "Andika reference number uliyopokea wakati ulipotuma maoni yako.");
    return;
  }
  busy(btn, true, "Inatafuta...");
  out.innerHTML = stateBox("busy", "Inatafuta...", "Tunatafuta maoni yako kwenye mfumo.");
  try {
    const rec = await API.trackFeedback(ref);
    if (!rec) {
      out.innerHTML = stateBox("error", "Hakuna rekodi",
        "Hakuna maoni yaliyopatikana kwa reference number <b>" + esc(ref) + "</b>. "
        + "Angalia kama umeikika vizuri — inapaswa kuwa mfano <b>RUC-2026-0001</b>.");
      return;
    }
    const steps = TRACK_STEPS;
    let idx = steps.indexOf(rec.status);
    if (idx < 0) idx = ["Closed", "Rejected/Invalid"].includes(rec.status) ? 3
      : rec.status === "Assigned" || rec.status === "Awaiting Information" ? 1 : 0;
    const closed = ["Closed", "Rejected/Invalid"].includes(rec.status);

    const meta = [
      ["Aina ya maoni", rec.submission_type],
      ["Kundi", rec.category || "—"],
      ["Imetuma", new Date(rec.created_at).toLocaleDateString()],
    ];

    out.innerHTML =
      '<div class="trackresult__head">'
      + '<div><p class="trackresult__ref">' + esc(ref) + '</p>'
      + '<p class="trackresult__status">Hali ya sasa: <span class="pill ' + (STCLASS[rec.status] || "neutral") + '">' + esc(rec.status) + "</span></p></div>"
      + (closed ? "" : '<span class="pill info">Inaendelea kushughulikiwa</span>')
      + "</div>"
      + '<dl class="metagrid">' + meta.map(([k, v]) =>
        "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>").join("") + "</dl>"
      + (rec.response
        ? '<div class="notebox"><p class="notebox__label">Majibu ya msimamizi</p><p>' + esc(rec.response) + "</p></div>"
        : '<p class="muted" style="margin-top:var(--sp-4)">Bado hakuna jibu. Msimamizi atashughulikia maoni yako; unaweza kufuatilia majibu kupitia ukurasa huu.</p>')
      + '<ol class="timeline">' + steps.map((s, i) => {
        const state = closed && i === 3 ? "current" : i < idx ? "done" : i === idx ? "current" : "todo";
        return '<li class="timeline__item" data-state="' + state + '">'
          + '<span class="timeline__dot">' + (state === "done" ? navIcon("M20 6L9 17l-5-5") : String(i + 1)) + "</span>"
          + '<div><p class="timeline__name">' + esc(s) + "</p>"
          + (i === idx ? '<p class="timeline__when">' + esc(rec.status) + "</p>" : "")
          + "</div></li>";
      }).join("") + "</ol>";
  } catch (e) {
    fail(out, e);
  } finally {
    busy(btn, false);
  }
}

// ---------- Admin auth ----------
// NOTE: login itself now happens on /leader/login/ and /admin/login/, not on
// this page — see the removed view-adminlogin section. This page only
// restores an existing session (see the boot sequence near the bottom of
// this file) so a staff member who is already signed in can still use the
// legacy dashboard/issues/reports/settings tabs while they're migrated.
async function logout(ev) {
  const btn = ev && ev.currentTarget;
  busy(btn, true, "Inatoka...");
  try {
    await D.audit("Logout", DB.session ? DB.session.email : "");
  } catch (_) { /* logging must never block sign-out */ }
  await API.adminLogout();
  DB.session = null;
  DB.feedback = []; DB.staff = []; DB.auditLog = []; DB.adminLoaded = false;
  D.writeUI({ lastView: "home" });
  currentView = "home";
  go("home");
}

// ---------- Dashboard ----------
async function renderDashboard() {
  const cards = document.getElementById("statCards");
  D.loading(cards, "Inapakia taarifa...");
  ["chartCat", "chartStatus", "chartMinistry", "recurring"].forEach((id) =>
    document.getElementById(id).innerHTML = '<p class="muted">Inapakia...</p>');
  try {
    await D.loadAdmin();
  } catch (e) {
    fail(cards, e);
    return;
  }
  const f = DB.feedback;
  const total = f.length;
  const byStatus = (s) => f.filter((x) => x.status === s).length;
  const critical = f.filter((x) => x.priority === "Critical").length;
  const ratings = f.filter((x) => x.rating).map((x) => Number(x.rating));
  const avgSat = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "—";
  cards.innerHTML = [
    ["Total Submissions", total], ["New", byStatus("New")], ["Under Review", byStatus("Under Review")],
    ["In Progress", byStatus("In Progress")], ["Resolved", byStatus("Resolved")],
    ["Critical Issues", critical], ["Avg. Satisfaction", avgSat],
    ["Wanafunzi Database", DB.studentCount],
    ["Resolution Rate", total ? Math.round(((byStatus("Resolved") + byStatus("Closed")) / total) * 100) + "%" : "—"],
  ].map(([l, v]) => `<div class="card stat"><b>${esc(v)}</b><span>${esc(l.toUpperCase())}</span></div>`).join("");

  const catCounts = {};
  f.forEach((x) => { catCounts[x.category] = (catCounts[x.category] || 0) + 1; });
  const maxC = Math.max(1, ...Object.values(catCounts));
  document.getElementById("chartCat").innerHTML = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `<div class="bar-row"><span style="width:120px;">${esc(c)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / maxC) * 100}%"></div></div><span>${v}</span></div>`)
    .join("") || '<p class="muted">No data yet.</p>';

  const stCounts = {};
  STATUSES.forEach((s) => { stCounts[s] = 0; });
  f.forEach((x) => { stCounts[x.status] = (stCounts[x.status] || 0) + 1; });
  const maxS = Math.max(1, ...Object.values(stCounts));
  document.getElementById("chartStatus").innerHTML = Object.entries(stCounts).filter(([, v]) => v > 0)
    .map(([s, v]) => `<div class="bar-row"><span style="width:120px;">${esc(s)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / maxS) * 100}%"></div></div><span>${v}</span></div>`).join("");

  const mnCounts = {};
  DB.ministries.forEach((m) => { mnCounts[m.name] = 0; });
  let noMinistry = 0;
  f.forEach((x) => { if (x.ministry) mnCounts[x.ministry] = (mnCounts[x.ministry] || 0) + 1; else noMinistry++; });
  const maxM = Math.max(1, ...Object.values(mnCounts), noMinistry);
  document.getElementById("chartMinistry").innerHTML = (Object.entries(mnCounts).filter(([, v]) => v > 0)
    .map(([m, v]) => `<div class="bar-row"><span style="width:120px;">${esc(m)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / maxM) * 100}%"></div></div><span>${v}</span></div>`).join("")
    + (noMinistry ? `<div class="bar-row"><span style="width:120px;">Bila Wizara</span><div class="bar-track"><div class="bar-fill" style="width:${(noMinistry / maxM) * 100}%"></div></div><span>${noMinistry}</span></div>` : ""))
    || '<p class="muted">No data yet.</p>';

  const rec = {};
  f.forEach((x) => { rec[x.category] = (rec[x.category] || 0) + 1; });
  const recurring = Object.entries(rec).filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1]);
  document.getElementById("recurring").innerHTML = recurring.length
    ? recurring.map(([c, v]) => `<div class="card" style="margin-bottom:8px;"><b>POSSIBLE RECURRING ISSUE</b><br>${esc(c)}<br>Reports: ${v}<br><span class="muted">AI-generated grouping — requires administrator confirmation.</span></div>`).join("")
    : "No recurring patterns detected yet.";
}

// ---------- Issues ----------
function populateFilters() {
  const fs = document.getElementById("filterStatus");
  const fc = document.getElementById("filterCategory");
  const fm = document.getElementById("filterMinistry");
  const keep = { s: fs.value, c: fc.value, m: fm.value };
  fs.innerHTML = '<option value="">All Statuses</option>' + STATUSES.map((s) => `<option>${esc(s)}</option>`).join("");
  fc.innerHTML = '<option value="">All Categories</option>' + DB.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  fm.innerHTML = '<option value="">Wizara Zote</option>' + DB.ministries.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("") + '<option value="__none__">Bila Wizara</option>';
  fs.value = keep.s; fc.value = keep.c; fm.value = keep.m;
}

async function renderIssues() {
  const rows = document.getElementById("issueRows");
  D.loading(rows, "Inapakia masuala...");
  try {
    if (!DB.adminLoaded) await D.loadAdmin();
  } catch (e) {
    rows.innerHTML = `<tr><td colspan="11" class="err">${esc(D.errText(e))}</td></tr>`;
    return;
  }
  populateFilters();
  const fs = document.getElementById("filterStatus").value;
  const fc = document.getElementById("filterCategory").value;
  const fm = document.getElementById("filterMinistry").value;
  const list = DB.feedback.filter((x) =>
    (!fs || x.status === fs) &&
    (!fc || x.category_id === fc) &&
    (!fm || (fm === "__none__" ? !x.ministry_id : x.ministry_id === fm)));
  rows.innerHTML = list.map((x) => `
    <tr>
      <td>${esc(x.ref)}</td>
      <td>${new Date(x.createdAt).toLocaleDateString()}</td>
      <td>${esc(x.category)}</td><td>${esc(x.type)}</td><td>${esc(x.title)}</td>
      <td>${x.anonymous ? "Anonymous" : esc(x.name || "—")}</td>
      <td><span class="pill ${PRCLASS[x.priority] || ""}">${esc(x.priority)}</span></td>
      <td><span class="pill ${STCLASS[x.status] || ""}">${esc(x.status)}</span></td>
      <td>${esc(x.ministry || "—")}</td>
      <td>${esc(x.assignedToName || "—")}</td>
      <td><a class="link" onclick="openIssue('${esc(x.ref)}')">View</a></td>
    </tr>`).join("") || '<tr><td colspan="11" class="muted">No issues match this filter.</td></tr>';
}

let currentIssueRef = null;

async function openIssue(ref) {
  const x = DB.feedback.find((f) => f.ref === ref);
  if (!x) return;
  currentIssueRef = ref;
  const m = document.getElementById("issueModal");
  m.innerHTML = '<p class="muted">Inapakia taarifa za ripoti…</p>';
  document.getElementById("issueModalBg").classList.add("active");
  let history = [], notes = [], attachments = [];
  try {
    [history, notes, attachments] = await Promise.all([
      API.listStatusHistory(x.id),
      API.listInternalNotes(x.id),
      API.listAttachments(x.id),
    ]);
    x._attachments = attachments;
  } catch (e) {
    D.toast(D.errText(e), "err");
  }
  m.innerHTML = `
    <span class="badge-close" onclick="closeIssue()">✕</span>
    <h3 style="margin-top:0;">${esc(x.ref)}</h3>
    <p><b>Category:</b> ${esc(x.category)} &nbsp; <b>Type:</b> ${esc(x.type)} &nbsp; <span class="pill ${PRCLASS[x.priority] || ""}">${esc(x.priority)}</span></p>
    <p><b>Student:</b> ${x.anonymous ? "Anonymous (identity protected)" : esc([x.name, x.reg, x.programme, x.year ? "Yr " + x.year : ""].filter(Boolean).join(" · "))}</p>
    <p><b>Description:</b><br>${esc(x.desc)}</p>
    ${x.solution ? `<p><b>Suggested Solution:</b> ${esc(x.solution)}</p>` : ""}
    ${attachments.length ? `<p><b>Attachment:</b> ${attachments.map((a) => `<a class="link" onclick="openAttachment('${esc(a.id)}')">${esc(a.file_name || "kiambatisho")}</a>`).join(", ")}</p>` : ""}
    <label>Status</label>
    <select id="modStatus">${STATUSES.map((s) => `<option ${s === x.status ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
    <label>Wizara (Ministry)</label>
    <select id="modMinistry"><option value="">— Hakuna —</option>${DB.ministries.filter((m2) => m2.active).map((m2) => `<option value="${m2.id}" ${m2.id === x.ministry_id ? "selected" : ""}>${esc(m2.name)}</option>`).join("")}</select>
    <label>Assigned Officer</label>
    <select id="modAssign"><option value="">— Hakuna —</option>${DB.staff.map((s) => `<option value="${s.id}" ${s.id === x.assignedTo ? "selected" : ""}>${esc(s.name)} (${esc(s.role)})</option>`).join("")}</select>
    <label>Admin Response</label>
    <textarea id="modResponse">${esc(x.response)}</textarea>
    <label>Internal Note (not visible to student)</label>
    <input id="modNote" placeholder="Add internal note">
    <div style="margin-top:10px;"><button class="pri" onclick="saveIssue('${esc(x.ref)}', event)">Save Changes</button></div>
    <div style="margin-top:14px;"><b>Activity History</b>
      ${history.length ? history.map((h) => `<div class="muted" style="font-size:11px;">${new Date(h.created_at).toLocaleString()} — ${esc(h.who?.full_name || "System")}: ${esc(h.old_status || "—")} → ${esc(h.new_status)}</div>`).join("") : '<div class="muted" style="font-size:11px;">Hakuna matukio bado.</div>'}
    </div>
    ${notes.length ? `<div style="margin-top:10px;"><b>Internal Notes</b>${notes.map((n) => `<div class="muted" style="font-size:11px;">${esc(n.note)} — ${esc(n.who?.full_name || "Msimamizi")} (${new Date(n.created_at).toLocaleString()})</div>`).join("")}</div>` : ""}
  `;
}

// Attachments live in a private bucket: staff get a short-lived signed link.
async function openAttachment(id) {
  try {
    const fb = DB.feedback.find((f) => f.ref === currentIssueRef);
    const att = ((fb && fb._attachments) || []).find((a) => a.id === id);
    if (!att) throw new Error("Kiambatisho hakikupatikana.");
    const url = await API.signedUrl(API.BUCKETS.attachments, att.file_url, 600);
    window.open(url, "_blank", "noopener");
  } catch (e) {
    D.toast(D.errText(e), "err");
  }
}

function closeIssue() { closeModal("issueModalBg"); }

async function saveIssue(ref, ev) {
  const btn = ev && ev.currentTarget;
  const x = DB.feedback.find((f) => f.ref === ref);
  if (!x) return;
  busy(btn, true, "Kuhifadhi...");
  try {
    const newStatus = document.getElementById("modStatus").value;
    const newMinistry = document.getElementById("modMinistry").value || null;
    const newAssign = document.getElementById("modAssign").value || null;
    const newResponse = document.getElementById("modResponse").value;
    const note = document.getElementById("modNote").value.trim();

    const patch = {};
    if (newStatus !== x.status) {
      patch.status = newStatus;
      if (newStatus === "Resolved") patch.resolved_at = new Date().toISOString();
    }
    if (newMinistry !== x.ministry_id) patch.ministry_id = newMinistry;
    if (newAssign !== x.assignedTo) patch.assigned_to = newAssign;
    if (newResponse !== x.response) patch.response = newResponse;

    if (Object.keys(patch).length) await API.updateFeedback(x.id, patch);
    if (patch.status) {
      await API.addStatusHistory(x.id, x.status, newStatus);
      await D.audit("Status Change", x.ref + ": " + x.status + " → " + newStatus);
    }
    if (note) {
      await API.addInternalNote(x.id, note);
      await D.audit("Internal Note Added", x.ref);
    }
    await D.loadAdmin();
    closeIssue();
    renderIssues();
    D.toast("Mabadiliko yamehifadhiwa.");
  } catch (e) {
    D.toast(D.errText(e), "err");
  } finally {
    busy(btn, false);
  }
}

// ---------- Reports ----------
async function renderReport() {
  const period = document.getElementById("reportPeriod").value;
  const out = document.getElementById("reportOut");
  D.loading(out, "Inatengeneza ripoti...");
  try {
    if (!DB.adminLoaded) await D.loadAdmin();
    const f = DB.feedback;
    const total = f.length;
    const catCounts = {};
    f.forEach((x) => { catCounts[x.category] = (catCounts[x.category] || 0) + 1; });
    const top = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const unresolved = f.filter((x) => !["Resolved", "Closed"].includes(x.status)).length;
    const critical = f.filter((x) => x.priority === "Critical").length;
    const ratings = f.filter((x) => x.rating).map((x) => Number(x.rating));
    const avgSat = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : "—";
    out.innerHTML = `
      <h3>RUCU Student Challenges Report</h3>
      <p class="muted">Academic Year ${esc(DB.acadYear)} · Period: ${esc(period)} · Generated ${new Date().toLocaleString()}</p>
      <p><b>Total reports:</b> ${total}</p>
      <p><b>Top reported categories:</b></p>
      <ol>${top.map(([c, v]) => `<li>${esc(c)} — ${v}</li>`).join("") || "<li>Hakuna data bado.</li>"}</ol>
      <p><b>Unresolved issues:</b> ${unresolved} &nbsp; <b>Critical issues:</b> ${critical} &nbsp; <b>Avg. satisfaction:</b> ${avgSat}/5</p>
      <p class="muted">Recommendations/observations are generated based on submitted data and should be reviewed by an authorized administrator before institutional action.</p>`;
  } catch (e) {
    fail(out, e);
  }
}

function reportStats() {
  const f = DB.feedback;
  const catCounts = {};
  f.forEach((x) => { catCounts[x.category] = (catCounts[x.category] || 0) + 1; });
  return {
    total: f.length,
    top: Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 5),
    unresolved: f.filter((x) => !["Resolved", "Closed"].includes(x.status)).length,
    critical: f.filter((x) => x.priority === "Critical").length,
    avgSat: (() => {
      const r = f.filter((x) => x.rating).map((x) => Number(x.rating));
      return r.length ? (r.reduce((a, b) => a + b, 0) / r.length).toFixed(2) : "—";
    })(),
  };
}

function exportPDF() {
  if (!window.jspdf) { D.toast("PDF library haijapatikana.", "err"); return; }
  const s = reportStats();
  const doc = new window.jspdf.jsPDF();
  let y = 18;
  doc.setFontSize(16); doc.text("RUCU Student Challenges Report", 14, y); y += 8;
  doc.setFontSize(10); doc.text("Academic Year " + DB.acadYear + " | Generated " + new Date().toLocaleString(), 14, y); y += 10;
  doc.setFontSize(12); doc.text("Total reports: " + s.total, 14, y); y += 8;
  doc.text("Unresolved: " + s.unresolved + "   Critical: " + s.critical + "   Avg. satisfaction: " + s.avgSat + "/5", 14, y); y += 10;
  doc.setFontSize(13); doc.text("Top reported categories:", 14, y); y += 8;
  doc.setFontSize(11);
  s.top.forEach(([c, v], i) => { doc.text((i + 1) + ". " + c + " — " + v, 18, y); y += 7; });
  y += 6; doc.setFontSize(9);
  doc.text("Recommendations/observations are generated from submitted data and require administrator review.", 14, y);
  doc.save("rucu_report.pdf");
}

function exportCSV() {
  const rows = [["Reference", "Date", "Category", "Type", "Subject", "Priority", "Status", "Anonymous"]];
  DB.feedback.forEach((x) => rows.push([x.ref, x.createdAt, x.category, x.type, x.title, x.priority, x.status, x.anonymous]));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rucu_report.csv";
  a.click();
}

// ---------- Documents ----------
async function renderDocuments() {
  const list = document.getElementById("docList");
  if (!list) return;
  const upload = document.getElementById("docUploadCard");
  if (upload) upload.classList.toggle("hidden", !DB.session);
  // skeletonLines() assigns to a host element and returns nothing, so it was
  // painting the literal text "undefined" here. skeleton() returns the markup.
  list.innerHTML = skeleton(4);
  try {
    await D.refreshDocuments();
  } catch (e) {
    if (!DB.documents.length) { fail(list, e); return; }
  }
  const docs = DB.documents;
  list.innerHTML = docs.length ? docs.map((d) => `
    <div class="docitem">
      <span class="docitem__icon">${navIcon("M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6")}</span>
      <div class="docitem__main">
        <p class="docitem__title">${esc(d.title)}</p>
        <p class="docitem__meta">${esc(d.category || "Hati")} · ${d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString() : "—"}</p>
      </div>
      <div class="docitem__acts">
        <a class="btn btn--ghost btn--sm" href="${esc(d.url)}" target="_blank" rel="noopener" download>${navIcon("M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3")} Pakua</a>
        ${DB.session ? '<button class="link link--danger" type="button" onclick="removeDocument(\'' + d.id + '\', event)">Ondoa</button>' : ""}
      </div>
    </div>`).join("")
    : '<p class="muted">Hakuna nyaraka zilizopakiwa bado. Msimamizi wa mfumo ndiye anaweza kupakia nyaraka.</p>';
}

async function addDocument(ev) {
  const btn = ev && ev.currentTarget;
  const title = document.getElementById("doc_title").value.trim();
  const file = document.getElementById("doc_file").files[0];
  if (!title || !file) { D.toast("Weka kichwa na chagua faili.", "err"); return; }
  if (file.size > 10 * 1024 * 1024) { D.toast("Faili ni kubwa mno (zaidi ya 10MB).", "err"); return; }
  busy(btn, true, "Inapakia...");
  try {
    await D.saveDocument({ title, category: document.getElementById("doc_cat").value.trim(), file });
    document.getElementById("doc_title").value = "";
    document.getElementById("doc_cat").value = "";
    document.getElementById("doc_file").value = "";
    await renderDocuments();
    D.toast("Hati imepakiwa.");
  } catch (e) {
    D.toast(D.errText(e), "err");
  } finally {
    busy(btn, false);
  }
}

async function removeDocument(id) {
  if (!confirm("Ondoa hati hii?")) return;
  try {
    await D.removeDocument(id);
    await renderDocuments();
    D.toast("Hati imeondolewa.");
  } catch (e) {
    D.toast(D.errText(e), "err");
  }
}

// ---------- Public detail modals ----------
// The cards on the homepage are summaries; these open the full record. The
// lists they read from are the same arrays the cards were rendered from, so a
// card and its modal can never disagree.
let visibleServices = [];
let visibleLeaders = [];
let visibleAnns = [];

const ICON_PHONE = "M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.8 2z";
const ICON_INFO = "M12 8v4M12 16h.01M12 3l9 16H3z";

// Services have no icon field, so the name picks one. Keeps the grid legible
// without an admin having to upload artwork for every row.
function serviceIcon(name) {
  const n = String(name || "").toLowerCase();
  if (/loan|malipo|payment|mshapo|financial|bursary/.test(n)) return "M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6";
  if (/chuo|college|programme|program|course|akadem|ndi|elimu|education/.test(n)) return "M22 10L12 5 2 10l10 5 10-5zM6 12v5c3 3 9 3 12 0v-5";
  if (/health|afya|medical|clinical|doctor|mugibu|wellness/.test(n)) return "M12 21s-8-4.6-8-10a5 5 0 018-3 5 5 0 018 3c0 5.4-8 10-8 10zM12 9v4M10 11h4";
  if (/ict|teh|tech|internet|network|support|mfumo|system/.test(n)) return "M4 4h16a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM8 21h8M12 17v4";
  if (/report|ripoti|complain|malalam|feedback|grievance/.test(n)) return "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11";
  if (/meeting|usiliani|baraza|counsel|advise|consult/.test(n)) return "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8";
  if (/research|utafiti|publication|jek|project|innovation/.test(n)) return "M9 3h6v5l-1.5 1.5L15 21H9l1.5-11.5zM9 8h6";
  if (/sport|michezo|games|club|shirika|recreation|burudani/.test(n)) return "M12 22a10 10 0 100-20 10 10 0 000 20zM12 8v4l3 2";
  return ICON_INFO;
}


function modalShell(bgId, title, bodyHtml, subtitle) {
  const bg = document.getElementById(bgId);
  if (!bg) return;
  const modal = bg.firstElementChild;
  modal.innerHTML =
    '<div class="modal__head"><div>'
    + '<p class="eyebrow" style="margin:0 0 4px">' + (subtitle || "RUCUSO") + "</p>"
    + "<h2>" + esc(title) + "</h2></div>"
    + '<button class="badge-close" type="button" aria-label="Funga" onclick="closeModal(\'' + bgId + '\')">&times;</button>'
    + "</div>" + bodyHtml;
  bg.classList.add("active");
  document.body.classList.add("modal-open");
  const close = modal.querySelector(".badge-close");
  rememberOpener(bg);
  if (close) close.focus();
  // clicking the backdrop (but not the sheet) dismisses
  bg.onclick = (e) => { if (e.target === bg) closeModal(bgId); };
}

function closeModal(bgId) {
  const bg = document.getElementById(bgId);
  if (!bg) return;
  bg.classList.remove("active");
  bg.onclick = null;
  if (!document.querySelector(".modal-bg.active")) document.body.classList.remove("modal-open");
  restoreOpener(bg);
}

function publicLeaderPosition(position) {
  const labels = {
    president: "Rais",
    secretary_general: "Katibu Mkuu",
    minister: "Waziri",
    deputy_minister: "Naibu Waziri",
    representative: "Mwakilishi",
    officer: "Afisa",
  };
  return labels[position] || position;
}

function openLeader(i) {
  const l = visibleLeaders[i];
  if (!l) return;
  const contact = l.phone
    ? '<a class="btn btn--gold" href="tel:' + esc(l.phone.replace(/\s+/g, "")) + '">' + navIcon(ICON_PHONE) + " " + esc(l.phone) + "</a>"
    : '<p class="muted">Namba ya simu ya kiongozi huyu bado haijawekwa kwenye mfumo.</p>';
  modalShell("leaderModalBg", l.name,
    '<span class="avatar" style="width:84px;height:84px;margin:0 0 var(--sp-4)">' + (l.photo
      ? '<img src="' + esc(l.photo) + '" alt="" width="84" height="84">'
      : navIcon("M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2")) + "</span>"
    + '<p class="leadercard__role" style="margin:0 0 var(--sp-3)">' + esc(publicLeaderPosition(l.position)) + "</p>"
    + (l.ministry ? '<p class="muted" style="margin:0 0 var(--sp-3)">' + esc(l.ministry) + "</p>" : "")
    + '<p style="color:var(--muted);line-height:1.75">' + (l.bio ? esc(l.bio) : "Maelezo ya majukumu ya kiongozi huyu bado hayajawekwa.") + "</p>"
    + '<div class="btnrow" style="margin-top:var(--sp-4);justify-content:flex-start">' + contact + "</div>",
    l.ministry || "Uongozi wa RUCUSO");
}

function publicServiceName(name) {
  return String(name || "").trim().toLowerCase() === "other services" ? "Huduma Nyingine" : name;
}

function openService(i) {
  const s = visibleServices[i];
  if (!s) return;
  modalShell("serviceModalBg", publicServiceName(s.name),
    '<p style="color:var(--muted);line-height:1.75;margin-top:0">'
    + (s.description ? esc(s.description) : "Maelezo ya huduma hii bado hayajawekwa na msimamizi wa mfumo.") + "</p>"
    + (s.contact ? '<p class="servicecard__contact">' + navIcon(ICON_PHONE) + esc(s.contact) + "</p>" : ""),
    "Huduma ya RUCUSO");
}

function openAnnouncement(i) {
  const a = visibleAnns[i];
  if (!a) return;
  modalShell("annModalBg", a.title,
    '<p class="muted" style="margin-top:0;font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--info)">'
    + esc(a.category || "Tangazo") + " · " + esc(a.audience || "Wanafunzi Wote") + "</p>"
    + '<p class="muted" style="font-size:var(--fs-xs)">Imetolewa: ' + new Date(a.createdAt).toLocaleDateString() + "</p>"
    + '<div style="white-space:pre-wrap;line-height:1.8">' + esc(a.description) + "</div>"
    + (a.expiryDate ? '<p class="muted" style="margin-top:var(--sp-4);font-size:var(--fs-xs)">Inaisha tarehe ' + new Date(a.expiryDate).toLocaleDateString() + "</p>" : ""),
    "Tangazo la RUCUSO");
}

// ---------- Student services ----------
async function renderServiceAdmin() {
  const el = document.getElementById("serviceAdminList");
  el.innerHTML = DB.services.map((s) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${esc(s.name)}${s.active ? "" : " (imezimwa)"}${s.description ? " — " + esc(s.description) : ""}</span>
      <span><a class="link" onclick="editService('${s.id}', event)">Hariri</a>&nbsp; <a class="link" onclick="toggleService('${s.id}', event)">${s.active ? "Zima" : "Washa"}</a> &nbsp;<a class="link" onclick="removeService('${s.id}', event)">Ondoa</a></span>
    </div>`).join("") || '<p class="muted">Hakuna huduma bado.</p>';
}

async function renderServices() {
  const grid = document.getElementById("serviceGrid");
  if (!grid) return;
  grid.innerHTML = skeleton(3);
  try {
    await D.refreshServices();
  } catch (e) {
    if (!DB.services.length) { fail(grid, e); return; }
  }
  const active = DB.services.filter((s) => s.active);
  visibleServices = active;
  grid.innerHTML = active.length ? active.map((s, i) => `
    <button type="button" class="servicecard" onclick="openService(${i})">
      <span class="servicecard__top">
        <span class="servicecard__icon">${navIcon(serviceIcon(s.name))}</span>
        <span class="servicecard__name">${esc(publicServiceName(s.name))}</span>
      </span>
      <span class="servicecard__desc">${s.description ? esc(s.description) : '<span class="muted">Maelezo ya huduma hii bado hayajawekwa.</span>'}</span>
      ${s.contact ? '<span class="servicecard__contact">' + navIcon("M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.8 2z") + esc(s.contact) + "</span>" : ""}
      <span class="servicecard__foot">
        <span class="servicecard__cta">Soma zaidi ${navIcon("M5 12h14M13 6l6 6-6 6")}</span>
      </span>
    </button>`).join("")
    : '<div class="statebox" style="grid-column:1/-1">' + stateBox("", "Huduma zitasanidiwa hivi karibuni",
      "Msimamizi wa mfumo ndiye anaweza kuongeza huduma za wanafunzi hapa.") + "</div>";
}

async function addService(ev) {
  const btn = ev && ev.currentTarget;
  const name = document.getElementById("sv_name").value.trim();
  if (!name) { D.toast("Weka jina la huduma.", "err"); return; }
  busy(btn, true, "Inahifadhi...");
  try {
    await D.saveService({ name, description: "", contact: "", active: false });
    document.getElementById("sv_name").value = "";
    renderServiceAdmin();
    D.toast("Huduma imeongezwa (imezimwa mpaka msimamizi aiweke maelezo).");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function editService(id) {
  const s = DB.services.find((x) => x.id === id);
  if (!s) return;
  const desc = prompt("Maelezo ya huduma '" + s.name + "':", s.description || "");
  if (desc === null) return;
  const contact = prompt("Mawasiliano (simu/email, hiari):", s.contact || "");
  if (contact === null) return;
  try {
    await D.saveService({ id, name: s.name, description: desc.trim(), contact: (contact || "").trim(), active: s.active });
    renderServiceAdmin();
  } catch (e) { D.toast(D.errText(e), "err"); }
}

async function toggleService(id) {
  const s = DB.services.find((x) => x.id === id);
  if (!s) return;
  try { await D.toggleService(id, !s.active); renderServiceAdmin(); } catch (e) { D.toast(D.errText(e), "err"); }
}

async function removeService(id) {
  if (!confirm("Ondoa huduma hii?")) return;
  try { await D.removeService(id); renderServiceAdmin(); } catch (e) { D.toast(D.errText(e), "err"); }
}

// ---------- Announcements ----------
async function renderAnnouncements() {
  const feat = document.getElementById("annFeatured");
  const list = document.getElementById("annList");
  if (!feat || !list) return;
  const create = document.getElementById("annCreateCard");
  if (create) create.classList.toggle("hidden", !DB.session);
  const pub = document.getElementById("an_publish");
  if (pub && !pub.value) pub.value = todayISO();
  feat.innerHTML = '<div class="skeleton skel-card" style="height:100%"></div>';
  list.innerHTML = skeleton(3);
  try {
    await D.refreshAnnouncements();
  } catch (e) {
    if (!DB.announcements.length) {
      feat.innerHTML = stateBox("error", "Imeshindikana kupakia matangazo", esc(D.errText(e)));
      list.innerHTML = "";
      return;
    }
  }
  const today = todayISO();
  const visible = DB.announcements
    .filter((a) => (!a.publishDate || a.publishDate <= today) && (!a.expiryDate || a.expiryDate >= today))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  visibleAnns = visible;

  // A remove control for every announcement, and only for a signed-in admin.
  // It sits *beside* the card rather than inside it: the cards are <button>
  // elements, and a button cannot legally contain another button. The delete
  // itself still goes through D.removeAnnouncement, so Supabase RLS remains
  // the real gate even if this markup is tampered with.
  const adminRow = (a) => DB.session
    ? '<div class="annadmin"><span class="annadmin__label">Msimamizi</span>'
      + '<button class="link link--danger" type="button" onclick="removeAnnouncement(\'' + a.id + '\')">Ondoa</button></div>'
    : "";

  if (!visible.length) {
    feat.innerHTML = '<div class="annfeature"><span class="annfeature__label">Matangazo</span>'
      + '<span class="annfeature__title">Hakuna tangazo kwa sasa</span>'
      + '<span class="annfeature__body">Hakuna taarifa mpya zilizochapishwa. Angalena na <b>Nyaraka</b> au tembelea tovuti za RUCUSO kupata taarifa za ziada.</span></div>';
    list.innerHTML = "";
    return;
  }

  const [first, ...rest] = visible;
  feat.innerHTML = `
    <button type="button" class="annfeature" onclick="openAnnouncement(0)">
      <span class="annfeature__label">${esc(first.category || "Tangazo la RUCUSO")}</span>
      <span class="annfeature__title">${esc(first.title)}</span>
      <span class="annfeature__body">${esc(first.description)}</span>
      <span class="annfeature__foot">
        <span class="muted" style="font-size:var(--fs-xs)">${esc(first.audience || "Wanafunzi Wote")} · ${new Date(first.createdAt).toLocaleDateString()}</span>
        <span class="servicecard__cta">Soma zaidi ${navIcon("M5 12h14M13 6l6 6-6 6")}</span>
      </span>
    </button>` + adminRow(first);

  list.innerHTML = rest.map((a, i) => `
    <div class="annitemwrap">
      <button type="button" class="annitem" onclick="openAnnouncement(${i + 1})">
        <span class="annitem__title">${esc(a.title)}</span>
        <span class="annitem__excerpt">${esc(a.description)}</span>
        <span class="muted" style="font-size:var(--fs-xs)">${a.category ? esc(a.category) + " · " : ""}${esc(a.audience || "Wanafunzi Wote")} · ${new Date(a.createdAt).toLocaleDateString()}</span>
      </button>
      ${adminRow(a)}
    </div>`).join("");
}

async function addAnnouncement(ev) {
  const btn = ev && ev.currentTarget;
  const title = document.getElementById("an_title").value.trim();
  const desc = document.getElementById("an_desc").value.trim();
  if (!title || !desc) { D.toast("Weka kichwa na maelezo.", "err"); return; }
  busy(btn, true, "Inachapisha...");
  try {
    await D.saveAnnouncement({
      title, description: desc,
      category: document.getElementById("an_cat").value.trim(),
      audience: document.getElementById("an_audience").value.trim() || "Wanafunzi Wote",
      publishDate: document.getElementById("an_publish").value || todayISO(),
      expiryDate: document.getElementById("an_expiry").value || null,
    });
    ["an_title", "an_desc", "an_cat", "an_publish", "an_expiry"].forEach((id) => { document.getElementById(id).value = ""; });
    document.getElementById("an_audience").value = "Wanafunzi Wote";
    document.getElementById("an_publish").value = todayISO();
    await renderAnnouncements();
    D.toast("Tangazo limechapishwa.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function removeAnnouncement(id) {
  if (!confirm("Ondoa tangazo hili?")) return;
  try { await D.removeAnnouncement(id); await renderAnnouncements(); } catch (e) { D.toast(D.errText(e), "err"); }
}

// ---------- Ministries ----------
async function renderMinistryAdmin() {
  const el = document.getElementById("ministryAdminList");
  el.innerHTML = DB.ministries.map((m) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${esc(m.name)}${m.active ? "" : " (imezimwa)"}</span>
      <span><a class="link" onclick="toggleMinistry('${m.id}', event)">${m.active ? "Zima" : "Washa"}</a> &nbsp;<a class="link" onclick="removeMinistry('${m.id}', event)">Ondoa</a></span>
    </div>`).join("") || '<p class="muted">Hakuna wizara bado.</p>';
}

async function addMinistry(ev) {
  const btn = ev && ev.currentTarget;
  const name = document.getElementById("mn_name").value.trim();
  if (!name) { D.toast("Weka jina la wizara.", "err"); return; }
  busy(btn, true, "Inahifadhi...");
  try {
    await D.saveMinistry(name, document.getElementById("mn_desc").value.trim());
    document.getElementById("mn_name").value = "";
    document.getElementById("mn_desc").value = "";
    await renderMinistryAdmin();
    renderLeaderAdmin();
    D.toast("Wizara imeongezwa. Nafasi 3 za uongozi zimeonekana kwenye orodha ya viongozi.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function toggleMinistry(id) {
  const m = DB.ministries.find((x) => x.id === id);
  if (!m) return;
  try { await D.toggleMinistry(id, !m.active); renderMinistryAdmin(); } catch (e) { D.toast(D.errText(e), "err"); }
}

async function removeMinistry(id) {
  if (!confirm("Ondoa wizara hii?")) return;
  try { await D.removeMinistry(id); renderMinistryAdmin(); renderLeaderAdmin(); } catch (e) { D.toast(D.errText(e), "err"); }
}

// ---------- Leadership directory ----------
async function renderLeadership() {
  const grid = document.getElementById("leaderGrid");
  if (!grid) return;
  grid.innerHTML = skeleton(4);
  try {
    await D.refreshLeaders();
  } catch (e) {
    if (!DB.leaders.length) { fail(grid, e); return; }
  }
  const active = DB.leaders.filter((l) => l.active && l.name);
  visibleLeaders = active;
  const notif = document.getElementById("leaderCount");
  if (notif) notif.textContent = String(active.length);
  grid.innerHTML = active.length ? active.map((l, i) => `
    <button type="button" class="leadercard" onclick="openLeader(${i})">
      <span class="avatar">${l.photo ? '<img src="' + esc(l.photo) + '" alt="" loading="lazy" width="92" height="92">' : navIcon("M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2")}</span>
      <span class="leadercard__name">${esc(l.name)}</span>
      <span class="leadercard__role">${esc(publicLeaderPosition(l.position))}</span>
      ${l.ministry ? '<span class="leadercard__ministry">' + esc(l.ministry) + "</span>" : ""}
      <span class="leadercard__more">${l.phone ? "Wasiliana" : "Maelezo"} ${navIcon("M5 12h14M13 6l6 6-6 6")}</span>
    </button>`).join("")
    : '<p class="muted" style="grid-column:1/-1">Taarifa za uongozi zitasanidiwa na msimamizi wa mfumo.</p>';
}

function renderLeaderAdmin() {
  const el = document.getElementById("leaderAdminList");
  const vacancies = D.vacantSlots();
  const real = DB.leaders.map((l) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${esc(l.position)}${l.ministry ? " (" + esc(l.ministry) + ")" : ""} — ${esc(l.name)}${l.active ? "" : " (imezimwa)"}</span>
      <span><a class="link" onclick="editLeader('${l.id}', event)">Jaza/Hariri</a> &nbsp;<a class="link" onclick="toggleLeaderActive('${l.id}', event)">${l.active ? "Zima" : "Washa"}</a> &nbsp;<a class="link" onclick="removeLeader('${l.id}', event)">Ondoa</a></span>
    </div>`).join("");
  const empty = vacancies.map((v) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${esc(v.position)}${v.ministry ? " (" + esc(v.ministry) + ")" : ""} — <span class="tag">NAFASI WAZI</span></span>
      <span><a class="link" onclick="fillVacancy('${esc(v.position)}','${v.ministry_id || ""}')">Jaza</a></span>
    </div>`).join("");
  el.innerHTML = (real + empty) || '<p class="muted">Hakuna kiongozi bado.</p>';
}

function fillVacancy(position, ministryId) {
  document.getElementById("ld_position").value = position;
  const sel = document.getElementById("ld_ministry");
  if (ministryId) {
    const m = DB.ministries.find((x) => x.id === ministryId);
    if (m) sel.value = m.name;
  }
  document.getElementById("ld_name").focus();
  document.getElementById("ld_name").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function addLeader(ev) {
  const btn = ev && ev.currentTarget;
  const name = document.getElementById("ld_name").value.trim();
  const position = document.getElementById("ld_position").value.trim();
  if (!name || !position) { D.toast("Weka jina na nafasi ya kiongozi.", "err"); return; }
  const ministryName = document.getElementById("ld_ministry").value.trim();
  const ministry = ministryName ? DB.ministries.find((m) => m.name.toLowerCase() === ministryName.toLowerCase()) : null;
  if (ministryName && !ministry) { D.toast("Wizara uliyoweka haipo. Ongeza wizara kwanza kwenye Mipangilio.", "err"); return; }
  busy(btn, true, "Inahifadhi...");
  try {
    let photo = null;
    const file = document.getElementById("ld_photo").files[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) { D.toast("Picha ni kubwa mno (zaidi ya 2MB).", "err"); return; }
      photo = await API.uploadFile(API.BUCKETS.photos, `${Date.now()}-${sanitizeFileName(file.name)}`, file);
    }
    await D.saveLeader({
      name, position, ministry_id: ministry ? ministry.id : null,
      phone: document.getElementById("ld_phone").value.trim(),
      bio: document.getElementById("ld_bio").value.trim(),
      photo, active: document.getElementById("ld_active").checked,
    });
    ["ld_name", "ld_position", "ld_ministry", "ld_phone", "ld_bio"].forEach((id) => { document.getElementById(id).value = ""; });
    document.getElementById("ld_photo").value = "";
    renderLeaderAdmin();
    renderLeadership();
    D.toast("Kiongozi amehifadhiwa.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function editLeader(id) {
  const l = DB.leaders.find((x) => x.id === id);
  if (!l) return;
  const name = prompt("Jina la kiongozi kwa nafasi '" + l.position + "':", l.name);
  if (name === null) return;
  const phone = prompt("Namba ya simu (mfano +255...):", l.phone || "");
  if (phone === null) return;
  const bio = prompt("Maelezo mafupi kuhusu kiongozi:", l.bio || "");
  if (bio === null) return;
  try {
    await D.saveLeader({
      id: l.id, name: name.trim(), position: l.position, ministry_id: l.ministry_id,
      phone: phone.trim(), bio: bio.trim(), photo: l.photo, active: l.active,
    });
    renderLeaderAdmin();
    renderLeadership();
    D.toast("Mabadiliko yamehifadhiwa.");
  } catch (e) { D.toast(D.errText(e), "err"); }
}

async function toggleLeaderActive(id) {
  const l = DB.leaders.find((x) => x.id === id);
  if (!l) return;
  try { await D.toggleLeader(id, !l.active); renderLeaderAdmin(); renderLeadership(); }
  catch (e) { D.toast(D.errText(e), "err"); }
}

async function removeLeader(id) {
  if (!confirm("Ondoa kiongozi huyu?")) return;
  try {
    await D.removeLeader(id);
    renderLeaderAdmin();
    renderLeadership();
    D.toast("Kiongozi ameondolewa.");
  } catch (e) { D.toast(D.errText(e), "err"); }
}

// ---------- Settings ----------
async function renderSettings() {
  const el = document.getElementById("auditRows");
  el.innerHTML = '<tr><td colspan="4" class="muted">Inapakia mipangilio…</td></tr>';
  try {
    await D.loadAdmin();
    await D.refreshProgrammes();
  } catch (e) { D.toast(D.errText(e), "err"); return; }
  document.getElementById("studentCount").textContent = DB.studentCount;
  el.innerHTML = DB.auditLog.slice(0, 50).map((a) =>
    `<tr><td>${new Date(a.at).toLocaleString()}</td><td>${esc(a.action)}</td><td>${esc(a.by)}</td><td>${esc(a.details || "")}</td></tr>`).join("")
    || '<tr><td colspan="4" class="muted">Hakuna matukio bado.</td></tr>';

  renderServiceAdmin();
  renderMinistryAdmin();
  renderLeaderAdmin();
  renderCategoryAdmin();
  document.getElementById("acadYear").value = DB.acadYear;
  document.getElementById("progList").innerHTML = DB.programmes.length ? DB.programmes.map((p) =>
    `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:13px;">${esc(p.name)}<a class="link" onclick="removeProgramme('${p.id}', event)">Remove</a></div>`).join("")
    : '<p class="muted" style="font-size:12px;">Hakuna programme bado — wanafunzi wataandika programme kama maandishi.</p>';
  document.getElementById("cfgPhone").value = DB.contacts.phone || "";
  document.getElementById("cfgEmail").value = DB.contacts.email || "";
}

async function addStudent(ev) {
  const btn = ev && ev.currentTarget;
  const name = document.getElementById("newStudName").value.trim();
  const reg = document.getElementById("newStudReg").value.trim();
  if (!name || !reg) { D.toast("Weka jina na registration number.", "err"); return; }
  busy(btn, true, "Inahifadhi...");
  try {
    await D.saveStudent(name, reg);
    document.getElementById("newStudName").value = "";
    document.getElementById("newStudReg").value = "";
    document.getElementById("studentCount").textContent = DB.studentCount;
    D.toast("Mwanafunzi amehifadhiwa.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

function nameToRow(name, reg) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const last = parts.length > 1 ? parts.pop() : "";
  const first = parts.join(" ");
  return {
    registration_number: reg,
    first_name: first || last,
    last_name: last || first,
  };
}

async function importStudentsCSV(ev) {
  const btn = ev && ev.currentTarget;
  const file = document.getElementById("csv_file").files[0];
  if (!file) { D.toast("Chagua faili la CSV kwanza.", "err"); return; }
  busy(btn, true, "Inaagiza...");
  try {
    const text = await file.text();
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) { D.toast("Faili haina data ya kutosha (angalau safu ya vichwa + mstari mmoja).", "err"); return; }
    const headers = lines[0].split(",").map((h) => h.trim().toUpperCase());
    const iReg = headers.indexOf("REGISTRATION NUMBER");
    const iFirst = headers.indexOf("FIRST NAME");
    const iMiddle = headers.indexOf("MIDDLE NAME");
    const iLast = headers.indexOf("LAST NAME");
    const iProg = headers.indexOf("PROGRAMME");
    const iYear = headers.indexOf("YEAR OF STUDY");
    const iPhone = headers.indexOf("PHONE");
    const iEmail = headers.indexOf("EMAIL");
    if (iReg === -1) { D.toast("Faili haina safu ya 'REGISTRATION NUMBER'. Angalia vichwa vya safu.", "err"); return; }

    const rows = [];
    let invalid = 0, dupInFile = 0;
    const seen = new Set();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      const reg = cols[iReg] || "";
      if (!reg) { invalid++; continue; }
      const key = reg.toLowerCase();
      if (seen.has(key)) { dupInFile++; continue; }
      seen.add(key);
      const first = iFirst > -1 ? (cols[iFirst] || "") : "";
      const middle = iMiddle > -1 ? (cols[iMiddle] || "") : "";
      const last = iLast > -1 ? (cols[iLast] || "") : "";
      if (!(first || middle || last)) { invalid++; continue; }
      // Parts are used as-is: nameToRow() would fold the middle name into
      // first_name and the generated full_name column would then repeat it.
      rows.push({
        registration_number: reg,
        first_name: first || middle || last,
        middle_name: middle || null,
        last_name: last || first,
        programme: iProg > -1 ? (cols[iProg] || null) : null,
        year_of_study: iYear > -1 ? (cols[iYear] || null) : null,
        phone_number: iPhone > -1 ? (cols[iPhone] || null) : null,
        email: iEmail > -1 ? (cols[iEmail] || null) : null,
      });
    }
    if (!rows.length) { D.toast("Hakuna mstari halali kuingizwa.", "err"); return; }
    const { added } = await D.importStudents(rows);
    document.getElementById("csv_file").value = "";
    document.getElementById("studentCount").textContent = DB.studentCount;
    D.toast(`Uagizaji umekamilika. Wapya: ${added} · Tayari wapo: ${rows.length - added + dupInFile} · Isiyo sahihi: ${invalid}`);
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function bulkImportStudents(ev) {
  const btn = ev && ev.currentTarget;
  const lines = document.getElementById("bulkStudents").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { D.toast("Andika orodha ya wanafunzi kwanza.", "err"); return; }
  busy(btn, true, "Inaagiza...");
  try {
    const rows = [];
    lines.forEach((l) => {
      const parts = l.split(",");
      if (parts.length < 2) return;
      const name = parts[0].trim();
      const reg = parts.slice(1).join(",").trim();
      if (name && reg) rows.push(nameToRow(name, reg));
    });
    if (!rows.length) { D.toast("Hakuna mstari halali kuingizwa.", "err"); return; }
    const { added } = await D.importStudents(rows);
    document.getElementById("bulkStudents").value = "";
    document.getElementById("studentCount").textContent = DB.studentCount;
    D.toast(added + " wanafunzi wameongezwa (wengine walikuwa tayari).");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function clearStudents(ev) {
  const phrase = prompt("Hii itafuta TAARIFA ZOTE za wanafunzi kwenye database._ANDika DELETE kuthibitisha:");
  if (phrase === null) return;
  if (String(phrase).trim().toUpperCase() !== "DELETE") {
    D.toast("Umezitisha kuthibitisho. Hakuna kilichofutwa.", "err");
    return;
  }
  const btn = ev && ev.currentTarget;
  busy(btn, true, "Inafuta...");
  try {
    await D.clearStudents();
    document.getElementById("studentCount").textContent = 0;
    D.toast("Taarifa za wanafunzi zimefutwa.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

function renderCategoryAdmin() {
  document.getElementById("catList").innerHTML = DB.categories.map((c) =>
    `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:13px;">${esc(c.name)}<a class="link" onclick="removeCategory('${c.id}', event)">Remove</a></div>`).join("");
}

async function addCategory(ev) {
  const btn = ev && ev.currentTarget;
  const v = document.getElementById("newCat").value.trim();
  if (!v) return;
  busy(btn, true, "Inahifadhi...");
  try {
    await D.saveCategory(v);
    document.getElementById("newCat").value = "";
    renderCategoryAdmin();
    populateCategories();
    D.toast("Category imeongezwa.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function removeCategory(id) {
  if (!confirm("Ondoa category hii?")) return;
  try { await D.removeCategory(id); await renderSettings(); } catch (e) { D.toast(D.errText(e), "err"); }
}

async function addProgramme(ev) {
  const btn = ev && ev.currentTarget;
  const v = document.getElementById("newProg").value.trim();
  if (!v) return;
  busy(btn, true, "Inahifadhi...");
  try {
    await D.saveProgramme(v);
    document.getElementById("newProg").value = "";
    await renderSettings();
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

async function removeProgramme(id) {
  try { await D.removeProgramme(id); await renderSettings(); } catch (e) { D.toast(D.errText(e), "err"); }
}

async function setAcadYear(ev) {
  try { await D.setAcadYear(document.getElementById("acadYear").value); D.toast("Mwaka wa masomo umehifadhiwa."); }
  catch (e) { D.toast(D.errText(e), "err"); }
}

async function saveContacts(ev) {
  const btn = ev && ev.currentTarget;
  busy(btn, true, "Inahifadhi...");
  try {
    await D.saveContacts(
      document.getElementById("cfgPhone").value.trim(),
      document.getElementById("cfgEmail").value.trim());
    D.toast("Mawasiliano yamehifadhiwa.");
  } catch (e) { D.toast(D.errText(e), "err"); } finally { busy(btn, false); }
}

// ---------- RUCUSO AI ----------
// The primary answer comes from the rucuso-ai Edge Function: a real language
// model, given live RUCUSO data that the caller is allowed to see.
// answerAI() below is kept only as a fallback for when that service cannot be
// reached, so the chat is never a dead box.
let aiBusy = false;
let aiHistory = [];

function openAI() {
  const p = document.getElementById("aiModalBg");
  if (!p) return;
  p.classList.add("active");
  const fab = document.getElementById("aiFab");
  if (fab) fab.setAttribute("aria-expanded", "true");
  rememberOpener(p);
  if (!document.getElementById("aiChat").childElementCount) {
    addAI("Habari! Mimi ni RUCUSO AI, msaidizi wa mfumo. Naweza kukusaidia kutumia RUCUSO, kueleza huduma zilizo kwa wanafunzi, kutangaza uongozi, na (kwa wasimamizi) kupewa muhtasari wa ripoti. Uliza chochote kwa lugha yako - mfano: 'Nianzie wapi?' au 'Nawezaje kuwasilisha malalamiko yangu?'");
  }
  const inp = document.getElementById("aiInput");
  if (inp) inp.focus();
}
function closeAI() {
  const p = document.getElementById("aiModalBg");
  if (!p) return;
  p.classList.remove("active");
  const fab = document.getElementById("aiFab");
  if (fab) fab.setAttribute("aria-expanded", "false");
  restoreOpener(p);
}
function toggleAI() {
  const p = document.getElementById("aiModalBg");
  if (p && p.classList.contains("active")) closeAI(); else openAI();
}
function addAI(text, who) {
  const c = document.getElementById("aiChat");
  const mine = who === "Wewe";
  const line = document.createElement("div");
  line.className = "bubble " + (mine ? "bubble--me" : "bubble--ai");
  const b = document.createElement("b");
  b.className = "bubble__who";
  b.textContent = who || "RUCUSO AI";
  const body = document.createElement("p");
  body.className = "bubble__text";
  // textContent, not innerHTML: the answer is model output and must never be
  // interpreted as markup. pre-wrap keeps the numbered lists readable.
  body.textContent = String(text == null ? "" : text);
  line.appendChild(b);
  line.appendChild(body);
  c.appendChild(line);
  c.scrollTop = c.scrollHeight;
  return line;
}
function removeAI(line) {
  if (line && line.parentNode) line.parentNode.removeChild(line);
}

// One Kiswahili sentence for whatever the Edge Function or the network said.
function aiErrorText(e) {
  const raw = String((e && e.message) || "").trim();
  const code = String((e && e.code) || "");
  if (code === "AI_NOT_CONFIGURED") {
    return "Huduma ya RUCUSO AI bado haijawekwa kwenye mfumo. Wasiliana na msimamizi wa mfumo.";
  }
  if (code === "RATE_LIMIT") {
    return raw || "Umefanya swali mengi m sana. Tafadhali subiri kidogo kisha jaribu tena.";
  }
  if (code === "AI_UNAVAILABLE") {
    return raw || "RUCUSO AI hapatikani kwa sasa. Tafadhali jaribu tena baadaye.";
  }
  if (code === "CONTEXT_UNAVAILABLE") {
    return raw || "Imeshindikana kupata taarifa za mfumo. Tafadhali jaribu tena.";
  }
  if (code === "SWALI_LIPU") return "Andika swali kwanza.";
  if (/jwt|token is expired|unauthor|sign in|log in|not authenticated/i.test(raw)) {
    return "Muda wa kuingia umeisha. Ingia tena ili kuendelea.";
  }
  if (/fetch|network|failed to fetch|load failed|timeout/i.test(raw)) {
    return "Imeshindikana kuwasiliana na huduma ya AI. Angalia interneti yako kisha jaribu tena.";
  }
  return raw || "Hitilafu isiyotarajiwa imetokea. Tafadhali jaribu tena.";
}

async function askAI() {
  const inp = document.getElementById("aiInput");
  const q = inp.value.trim();
  if (!q || aiBusy) return;

  addAI(q, "Wewe");
  inp.value = "";
  aiBusy = true;
  inp.disabled = true;

  const thinking = addAI("RUCUSO AI anafikiri...", "RUCUSO AI");
  thinking.style.opacity = "0.6";

  try {
    const res = await API.askAI(q, aiHistory, currentView);
    removeAI(thinking);
    const answer =
      (res && res.answer && res.answer.trim()) ||
      "Samahani, sikuweza kupata jibu kwa sasa. Tafadhali ulize tena.";
    addAI(answer, "RUCUSO AI");
    aiHistory.push({ role: "user", content: q }, { role: "assistant", content: answer });
    aiHistory = aiHistory.slice(-6);
  } catch (e) {
    removeAI(thinking);
    // Say why, then fall back to the built-in answers so the user still gets
    // something useful.
    const fallback = answerAI(q.toLowerCase());
    addAI(aiErrorText(e) + (fallback ? "\n\n" + fallback : ""), "RUCUSO AI");
  } finally {
    aiBusy = false;
    inp.disabled = false;
    inp.focus();
  }
}

// Fallback only: the original keyword answers, used when the AI service is
// unavailable. Same behaviour as before this upgrade.
function answerAI(q) {
  const f = DB.feedback;
  const staff = !!DB.session;
  if (q.includes("nijaze") || q.includes("kichwa")) return "Unaweza kuweka kichwa kifupi kinachoelezea tatizo. Mfano: 'Changamoto ya Internet katika hosteli'.";
  if (q.includes("nianzie") || (q.includes("nifanye") && currentView === "home")) return "Uko kwenye ukurasa wa mwanzo. Bonyeza 'Toa Maoni' kutoa maoni, au 'Fuatilia Taarifa' kufuatilia lililotumwa.";
  if (currentView === "settings" && (q.includes("nifanye") || q.includes("category"))) return "Uko kwenye Mipangilio → Categories. Fuata hatua hizi:\n1. Andika jina la category kwenye kisanduku.\n2. Bonyeza Add.\n3. Category itaonekana kwenye orodha na fomu ya wanafunzi.";
  if (q.includes("report") && (q.includes("ninawezaje") || q.includes("tengeneza") || q.includes("month"))) return "Nenda kwenye tab ya Ripoti, chagua Period, kisha bonyeza Generate Report. Unaweza Export CSV au Print.";
  if (q.includes("export")) return "Kwenye ukurasa wa Ripoti, bonyeza 'Export CSV' kupata faili la data, au 'Print' kupata nakala ya PDF kupitia dirisha la kuchapisha la kivinjari.";
  if (q.includes("status") && q.includes("badilisha")) return "Kwenye Masuala, bonyeza 'View' kwenye ripoti husika, chagua Status mpya kwenye dropdown, kisha 'Save Changes'.";
  if (q.includes("assign")) return "Kwenye dirisha la 'View' la ripoti, chagua msimamizi kwenye 'Assigned Officer' kisha bonyeza Save Changes.";
  if (q.includes("uongozi") || q.includes("rais")) return DB.leaders.length
    ? `DATABASE FACT: Kwa sasa kuna ${DB.leaders.filter((l) => l.active && l.name).length} viongozi waliopo kwenye database.`
    : "Hakuna kiongozi amewekwa kwenye database bado.";
  if (q.includes("huduma")) return DB.services.filter((s) => s.active).length
    ? `DATABASE FACT: Kuna ${DB.services.filter((s) => s.active).length} huduma zilizo wazi kwa wanafunzi sasa hivi.`
    : "Hakuna huduma zilizo wazi kwa sasa. Msimamizi wa mfumo bado zinapitishwa.";
  if (q.includes("matangazo")) return DB.announcements.length
    ? `DATABASE FACT: Kuna ${DB.announcements.length} matangazo yaliyochapishwa na yanayoendelea kuonekana.`
    : "Hakuna matangazo yaliyochapishwa kwa sasa.";
  if (!staff) {
    return "DATABASE FACT: Taarifa za ripoti zinazolindwa kwa wasimamizi pekee. Ningekuweza kukusaidia kwenye huduma, matangazo, uongozi na namna ya kutumia mfumo — uliza kuhuso hizo.";
  }
  if (q.includes("unresolved")) return `DATABASE FACT: Kuna ripoti ${f.filter((x) => !["Resolved", "Closed"].includes(x.status)).length} ambazo bado hazijamalizika (unresolved).`;
  if ((q.includes("ngapi") && q.includes("ripoti")) || q.includes("zimepokelewa")) return `DATABASE FACT: Jumla ya ripoti zilizopokelewa ni ${f.length}.`;
  if (q.includes("satisfaction") || q.includes("kuridhika")) {
    const ratings = f.filter((x) => x.rating).map((x) => Number(x.rating));
    const avg = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : "—";
    return `DATABASE FACT: Wastani wa kuridhika (satisfaction) ni ${avg} kati ya 5, kutoka ripoti ${ratings.length} zenye rating.`;
  }
  if (q.includes("zimeripotiwa sana") || q.includes("category gani")) {
    const cc = {};
    f.forEach((x) => { cc[x.category] = (cc[x.category] || 0) + 1; });
    const top = Object.entries(cc).sort((a, b) => b[1] - a[1])[0];
    return top ? `AI-GENERATED SUMMARY: Category inayoongoza kwa ripoti ni "${top[0]}" (${top[1]} ripoti). Hii si uamuzi rasmi wa kiutawala mpaka msimamizi athibitishe.` : "Hakuna data ya kutosha bado.";
  }
  if (q.includes("dashboard") && q.includes("maana")) return "Dashboard inaonyesha muhtasari wa ripoti zote: idadi jumla, mpya, zinazoendelea, zilizotatuliwa, masuala ya dharura (critical), na wastani wa kuridhika kwa wanafunzi.";
  return "Samahani, sijaelewa vizuri swali lako. Jaribu: 'Nianzie wapi?', 'Ninawezaje kubadilisha status?', 'Ni ripoti ngapi zimepokelewa?', au 'Nisaidie kutengeneza report'.";
}

// ---------- init ----------
async function boot() {
  const startupNavigationVersion = navigationVersion;
  D.purgePrototypeStorage();
  DB.studentSession = D.loadStudentSession();
  const ui = D.readUI();
  if (ui.theme) document.documentElement.setAttribute("data-theme", ui.theme);

  initDrawer();
  initWizard();
  fbPaint();

  if (!API) {
    const home = document.getElementById("homeview");
    if (home) {
      const warn = document.createElement("div");
      warn.className = "container";
      warn.innerHTML = stateBox("error", "Mfumo haujaunganishwa na database",
        "Haipatikani taarifa za muunganisho wa Supabase. Tafadhali wasiliana na msimamizi wa mfumo.");
      home.insertBefore(warn, home.firstChild);
    }
    renderTabs();
    return;
  }

  try {
    const s = await API.currentSession();
    if (s) await D.setSession(s);
  } catch (_) { /* not signed in / offline: continue as visitor */ }

  renderTabs();

  try {
    await D.loadPublic();
    DB.ready = true;
  } catch (e) {
    D.toast(D.errText(e), "err");
  }

  // Paint the page from whatever is cached, then let each renderer swap its
  // own placeholder for real content as the read lands. A visitor never sees a
  // blank page because one table was slow.
  if (navigationVersion === startupNavigationVersion) go("home");
  else renderHomeSections();

  // A deep link like /#sec-services or /#sec-contact should land on the right
  // section, and the browser's own back button should work from there.
  if (location.hash) {
    const want = location.hash.slice(1);
    if (PUBLIC_NAV.some(([id]) => id === want)) goSection(want);
  }
  window.addEventListener("hashchange", () => {
    const want = location.hash.slice(1);
    if (want && PUBLIC_NAV.some(([id]) => id === want)) goSection(want);
  });

  if (DB.session) {
    try { await D.loadAdmin(); } catch (e) { D.toast(D.errText(e), "err"); }
  }
}

boot();
