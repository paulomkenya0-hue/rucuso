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
const TRACK_STEPS = ["Imepokelewa", "Inafanyiwa Kazi", "Imekamilika"];
const STATUS_LABELS = {
  New: "Imepokelewa", "Under Review": "Inakaguliwa", Assigned: "Imekabidhiwa",
  "In Progress": "Inafanyiwa kazi", "Awaiting Information": "Inasubiri taarifa",
  Resolved: "Imekamilika", Closed: "Imefungwa", "Rejected/Invalid": "Haijakubaliwa",
};

// One sentence per error code the three verification functions can still
// return.
//
// Every code that used to depend on whether a registration number exists has
// been removed from the server, and is therefore removed from this map too:
//   INVALID_REGISTRATION, STUDENT_NOT_FOUND, PHONE_MISMATCH  (send-otp)
//   NO_PENDING_CODE, CODE_EXPIRED, TOO_MANY_ATTEMPTS         (verify-otp)
//   SMS_SEND_FAILED, COULD_NOT_ISSUE, INVALID_PHONE          (send-otp)
//
// A code cannot be rendered safely if the server can emit it, so the fix was to
// stop emitting it. Leaving the old entries here would be the same leak wearing
// a dead key: a future change that reintroduced one of these server-side would
// light up a student-facing message that says exactly which case was hit.
//
// What remains describes the deployment or the caller's own rate limit. None of
// it tells you anything about the registry, because none of it varies with it.
const OTP_MESSAGES = {
  INVALID_CODE: "Namba ya uthibitisho si sahihi au imeisha muda wake. Tuma namba mpya.",
  INVALID_CODE_FORMAT: "Namba ya uthibitisho lazima iwe tarakimu 6.",
  TOO_MANY_REQUESTS: "Umetuma maombi mengi. Subiri muda mrefu kabla ya jaribu tena.",
  SMS_PROVIDER_NOT_CONFIGURED: "Huduma ya kutuma SMS haijawekwa bado. Tafadhali wasiliana na msimamizi wa mfumo.",
  LOOKUP_FAILED: "Imeshindikana kuangalia namba ya usajili. Tafadhali jaribu tena baadaye.",
  // NOT_CONFIGURED is deliberately absent, and so is any CAPTCHA code. The
  // lookup step renders one generic sentence and logs the real reason to the
  // console, and a CAPTCHA fault is reported by verify-ux.js before a request
  // is ever made. See the note in lookupFailureText() below.
};

// ---------- small helpers ----------
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// Swaps a button into and out of a busy state.
//
// Structure-preserving on purpose: it writes into .btn__label when one is
// present rather than assigning textContent, because assigning textContent
// would delete the .btn__spin element and the button's other children, and
// then the next busy() call would have no label node left to restore into.
// Buttons without those spans fall back to plain text, so this still works on
// every existing call site unchanged.
function busy(btn, on, label) {
  if (!btn) return;
  const lab = btn.querySelector(".btn__label");
  if (on) {
    if (!btn.dataset.label) btn.dataset.label = lab ? lab.textContent : btn.textContent;
    const text = label || "Inahifadhi...";
    if (lab) lab.textContent = text;
    else btn.textContent = text;
    btn.classList.add("is-busy");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
  } else {
    if (lab && btn.dataset.label) lab.textContent = btn.dataset.label;
    else if (!lab && btn.dataset.label) btn.textContent = btn.dataset.label;
    if (btn.dataset.label) delete btn.dataset.label;
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    // A button that was disabled only because the form was invalid should go
    // back to its own state, not force itself on. RucusoVerify owns that
    // decision now — it knows about the format rule, the attempt budget and the
    // CAPTCHA gate all at once, and duplicating any of it here would drift.
    if (btn.id === "ver1_btn" && window.RucusoVerify) {
      window.RucusoVerify.setButtonState();
    }
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

function updatePortalClock() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("sw-TZ", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Dar_es_Salaam",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Africa/Dar_es_Salaam",
  }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Africa/Dar_es_Salaam" }).format(now));
  const greeting = hour >= 5 && hour < 12 ? "Habari za asubuhi" : hour >= 12 && hour < 18 ? "Habari za mchana" : "Habari za jioni";
  const clock = document.getElementById("portalClock");
  const greetingEl = document.getElementById("portalGreeting");
  const heroGreeting = document.getElementById("heroGreeting");
  if (clock) {
    // Day + date + time, e.g. "Jumatatu, 26 Oktoba 2026 · 10:42:18". The
    // machine-readable value carries the Tanzania wall-clock time, not the
    // visitor's, so anything reading the attribute gets EAT and not their own
    // timezone.
    clock.textContent = `${date} · ${time}`;
    clock.setAttribute("datetime", clockStamp(now));
  }
  if (greetingEl) greetingEl.textContent = greeting;
  if (heroGreeting) heroGreeting.textContent = `${greeting} · Ruaha Catholic University`;
}

// YYYY-MM-DDTHH:MM:SS+03:00 for the given instant, in Africa/Dar_es_Salaam.
function clockStamp(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZone: "Africa/Dar_es_Salaam",
  }).format(now);
  return parts.replace(",", "") + "+03:00";
}

// Light is the default appearance for everyone. Dark mode is a preference the
// visitor turns on with the toggle and we remember in rucu_ui_v1; it is never
// inferred from the operating system's colour scheme, which used to hand every
// dark-mode device a near-black site.
const DEFAULT_THEME = "light";

function paintThemeToggle(theme) {
  const button = document.getElementById("themeToggle");
  if (!button) return;
  const dark = theme === "dark";
  const target = dark ? "mepesi" : "meusi";
  button.setAttribute("aria-label", `Washa mandhari ${target}`);
  button.title = `Washa mandhari ${target}`;
  button.innerHTML = dark
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.5 15.5A8.5 8.5 0 018.5 3.5a8.5 8.5 0 1012 12z"/></svg>';
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme") || DEFAULT_THEME;
  const next = current === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  D.writeUI({ theme: next });
  paintThemeToggle(next);
}

function initHeroCanvas() {
  const canvas = document.getElementById("heroCanvas");
  const hero = canvas && canvas.closest(".hero");
  const context = canvas && canvas.getContext("2d");
  if (!canvas || !hero || !context) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) return;
  let width = 0;
  let height = 0;
  let frame = 0;
  let active = false;
  let visible = false;
  let particles = [];
  let pointer = { x: -1000, y: -1000 };
  const resize = () => {
    const rect = hero.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = width < 600 ? 14 : 30;
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width, y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
    }));
  };
  const draw = () => {
    if (!active) return;
    context.clearRect(0, 0, width, height);
    particles.forEach((particle, index) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      if (particle.x < 0 || particle.x > width) particle.vx *= -1;
      if (particle.y < 0 || particle.y > height) particle.vy *= -1;
      const dx = particle.x - pointer.x;
      const dy = particle.y - pointer.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 110) {
        particle.x += dx / Math.max(distance, 1) * 0.12;
        particle.y += dy / Math.max(distance, 1) * 0.12;
      }
      context.fillStyle = "rgba(217,189,126,.32)";
      context.fillRect(particle.x, particle.y, 2, 2);
      for (let other = index + 1; other < particles.length; other++) {
        const next = particles[other];
        const gap = Math.hypot(particle.x - next.x, particle.y - next.y);
        if (gap < 94) {
          context.strokeStyle = `rgba(217,189,126,${0.10 * (1 - gap / 94)})`;
          context.beginPath(); context.moveTo(particle.x, particle.y); context.lineTo(next.x, next.y); context.stroke();
        }
      }
    });
    frame = requestAnimationFrame(draw);
  };
  const start = () => {
    if (active || !visible || reduced.matches) return;
    resize();
    active = true;
    draw();
  };
  const stop = () => {
    active = false;
    cancelAnimationFrame(frame);
  };
  hero.addEventListener("pointermove", (event) => {
    const rect = hero.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, { passive: true });
  hero.addEventListener("pointerleave", () => { pointer = { x: -1000, y: -1000 }; }, { passive: true });
  addEventListener("resize", () => { if (active) resize(); }, { passive: true });
  if ("IntersectionObserver" in window) {
    const visibility = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) start(); else stop();
    });
    visibility.observe(hero);
  } else { visible = true; start(); }
  reduced.addEventListener("change", () => {
    if (reduced.matches) { stop(); context.clearRect(0, 0, width, height); }
    else start();
  });
}

function initScrollReveals() {
  const home = document.getElementById("homeview");
  if (!home || !("IntersectionObserver" in window)) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("is-revealed");
    observer.unobserve(entry.target);
  }), { threshold: 0.12 });
  const observe = (root) => {
    const selectors = ".section,.quickcard,.hero__panel,.servicecard,.annfeature,.annitem,.section > .container > .sectionhead-row";
    const nodes = [];
    if (root.matches?.(selectors)) nodes.push(root);
    nodes.push(...root.querySelectorAll?.(selectors) || []);
    nodes.forEach((node, index) => {
      if (node.dataset.revealObserved) return;
      node.dataset.revealObserved = "true";
      node.classList.add("reveal");
      node.style.setProperty("--reveal-delay", `${Math.min(index, 5) * 45}ms`);
      if (reduced) node.classList.add("is-revealed");
      else observer.observe(node);
    });
  };
  observe(home);
  new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) observe(node);
  }))).observe(home, { childList: true, subtree: true });
}

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

  // The location map lives inside the verify view, so it was display:none until
  // this line ran. The IntersectionObserver in js/map.js is only an optimisation
  // because a hidden element has no box to observe; this is the reliable
  // trigger. ensure() is idempotent and also re-measures a map built earlier.
  if (id === "verify" && window.RucusoMap) window.RucusoMap.ensure();

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
  renderImportantLinks();
  renderServices();
  renderAnnouncements();
  renderLeadership();
  renderDocuments();
  homeRendered = true;
}

// ---------- Viungo Muhimu ----------
//
// The list comes from D (system_settings `important_links`, already filtered
// through normalizeLinks in the data layer), so anything rendered here has
// survived that allow-list. External links open in a new tab with
// rel="noopener noreferrer"; in-page anchors (#sec-contact) stay in the same tab
// so the scroll behaviour still works.
function renderImportantLinks() {
  const grid = document.getElementById("linkGrid");
  if (!grid) return;
  const links = Array.isArray(DB.importantLinks) ? DB.importantLinks : [];
  if (!links.length) { grid.innerHTML = ""; return; }

  grid.innerHTML = links.map((item) => {
    const external = !item.url.startsWith("#");
    const target = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    const icon = D.ICON_SVGS[item.icon] || D.ICON_SVGS.university;
    const note = item.note ? `<span class="linkcard__note">${esc(item.note)}</span>` : "";
    const host = external ? safeHost(item.url) : "";
    const meta = host ? `<span class="linkcard__host">${esc(host)}</span>` : "";
    return `<a class="linkcard" href="${esc(item.url)}"${target}>
      <span class="linkcard__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      </span>
      <span class="linkcard__body">
        <span class="linkcard__title">${esc(item.label)}${external ? '<span class="linkcard__ext" aria-hidden="true">↗</span>' : ""}</span>
        ${note}
        ${meta}
      </span>
    </a>`;
  }).join("");
}

// Shows the host so a visitor can see where a link goes before tapping it.
// Falls back to the raw string if URL parsing is unavailable.
function safeHost(url) {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

document.addEventListener("change", (e) => {
  if (e.target.id === "f_anon") {
    document.getElementById("identBlock").classList.toggle("hidden", e.target.checked);
  }
});

const heslbVerifyForm = document.getElementById("heslbVerifyForm");
if (heslbVerifyForm) {
  const button = document.getElementById("heslbVerifyButton");
  const message = document.getElementById("heslbVerifyMessage");
  const success = document.getElementById("heslbVerified");
  const step1 = document.getElementById("heslbStep1");
  const step2 = document.getElementById("heslbStep2");
  const step3 = document.getElementById("heslbStep3");
  const stepItems = [...document.querySelectorAll("[data-heslb-step]")];
  function setHeslbStep(step) {
    step1.classList.toggle("hidden", step !== 1);
    step2.classList.toggle("hidden", step !== 2);
    step3.classList.toggle("hidden", step !== 3);
    stepItems.forEach((item) => {
      const number = Number(item.dataset.heslbStep);
      item.dataset.state = number < step ? "done" : number === step ? "active" : "todo";
    });
    if (step === 1) document.getElementById("heslbIndex").focus();
    if (step === 2) document.getElementById("heslbPhone").focus();
  }
  document.getElementById("heslbContinue").addEventListener("click", () => {
    const index = document.getElementById("heslbIndex");
    if (!index.reportValidity()) return;
    message.textContent = "";
    setHeslbStep(2);
  });
  document.getElementById("heslbPrevious").addEventListener("click", () => setHeslbStep(1));
  heslbVerifyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const phoneInput = document.getElementById("heslbPhone");
    if (!phoneInput.reportValidity()) return;
    const indexNumber = document.getElementById("heslbIndex").value.trim();
    const phone = phoneInput.value.trim();
    message.textContent = "";
    success.classList.add("hidden");
    button.disabled = true;
    button.textContent = "Inathibitisha...";
    try {
      const verified = await API.verifyHeslbBeneficiary(indexNumber, phone);
      if (!verified) throw new Error("verification_failed");
      setHeslbStep(3);
      success.classList.remove("hidden");
      success.focus({ preventScroll: true });
    } catch (_) {
      message.textContent = "Hatukuweza kuthibitisha taarifa ulizoingiza. Hakikisha Namba ya Usajili na namba ya simu ni sahihi.";
    } finally {
      button.disabled = false;
      button.textContent = "Thibitisha";
    }
  });
}

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
  const ai = document.getElementById("aiModalBg");
  if (e.key === "Tab" && ai && ai.classList.contains("active")) {
    const focusable = [...ai.querySelectorAll('button:not([disabled]),input:not([disabled]),[href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ai.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !ai.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    }
    return;
  }
  if (e.key !== "Escape") return;
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
    if (!el || el.dataset.counterDone === "true") return;
    const target = n[id];
    if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = target;
      el.dataset.counterDone = "true";
      return;
    }
    el.textContent = "0";
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const start = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - start) / 650);
        el.textContent = String(Math.round(target * (1 - Math.pow(1 - progress, 3))));
        if (progress < 1) requestAnimationFrame(step);
        else el.dataset.counterDone = "true";
      };
      requestAnimationFrame(step);
    }, { threshold: 0.6 });
    observer.observe(el);
  });
}

function renderContacts() {
  const phone = DB.contacts.phone || "";
  const email = DB.contacts.email || "";
  const year = DB.acadYear || "2026/2027";

  const set = (id, value, href, txt) => {
    const el = document.getElementById(id);
    if (!el) return;
    const icon = el.parentElement && el.parentElement.querySelector("svg");
    if (!value) { el.textContent = txt; el.removeAttribute("href"); el.className = "footercontact__none"; if (icon) icon.hidden = true; return; }
    el.textContent = value;
    if (href && el.tagName === "A") el.href = href;
    el.className = "";
    if (icon) icon.hidden = false;
  };
  set("footPhone", phone, "tel:" + phone.replace(/\s+/g, ""), "Taarifa za mawasiliano zitawekwa na msimamizi.");
  set("footEmail", email, "mailto:" + email, "Taarifa za mawasiliano zitawekwa na msimamizi.");
  set("contactPhone", phone, "tel:" + phone.replace(/\s+/g, ""), "Taarifa za mawasiliano zitawekwa na msimamizi.");
  set("contactEmail", email, "mailto:" + email, "Taarifa za mawasiliano zitawekwa na msimamizi.");
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
// The registration number on the feedback form never reveals a name.
//
// This used to autofill the student's name and print it on screen ("jina
// limepatikana: …"). The field is not restricted to a verified session's
// student: typing any registration number into it was enough to read that
// person's name out of the database, with no OTP, no session and no rate limit
// beyond the browser's debounce. It is also redundant now — the name and the
// number are both filled in read-only from the verified session, and the OTP in
// verifyOtp() is what proves the session.
//
// So this no longer calls the registry at all. It only checks the shape of the
// number and explains where the name comes from.
function lookupReg() {
  const reg = document.getElementById("f_reg").value.trim();
  const msg = document.getElementById("regLookupMsg");
  clearTimeout(regLookupTimer);
  if (!reg) { msg.textContent = ""; return; }
  regLookupTimer = setTimeout(() => {
    if (reg.length < 3) {
      msg.innerHTML = '<span class="muted">Namba ya usajili inapaswa kuwa na tarakimu 3 au zaidi.</span>';
    } else {
      msg.innerHTML = '<span class="muted">Jina na namba ya usajili hujulikana kutoka kwenye'
        + ' uthibitisho wako wa OTP.</span>';
    }
  }, 350);
}

// ---------- Student verification: reg number -> OTP -> identity ----------
//
// REQUIRE_SMS_OTP is now only read by the submit-screen guard below, where it
// requires otp_verified before anything can be filed. It is not a switch any
// more and must not become one again: the phone-on-file path it used to select
// between disclosed a student's identity with no SMS involved, which is the
// same pre-OTP disclosure the rest of this flow exists to prevent, and the
// registration-number screen it depended on is the oracle that has just been
// closed. There is no code to flip.
//
// The provider (Beem or Africa's Talking) lives only in the send-otp Edge
// Function, so the code, its hash and the API key never reach the browser.
const REQUIRE_SMS_OTP = true;

// The affirmative message. Shown only once the OTP has been proved, which is
// the only point in the flow at which anything has actually been verified.
const VERIFIED_TEXT = "Utambulisho umethibitishwa kikamilifu!";
const VERIFIED_HOLD_MS = 900;

let verifyMatch = null;

// What is shown when the lookup step fails for a reason that has nothing to do
// with whether the number exists: a dropped connection, a rate limit, a CAPTCHA
// the server would not accept, a missing rate-limit secret.
//
// It used to say "Namba ya usajili sio sahihi au haijapatikana" — "that
// registration number is wrong or not found" — which was there to be identical
// to the not-found message. It cannot be that any more, because a number that
// is not in the registry no longer produces a failure at all: it moves on to
// the OTP screen exactly like a real one. So this sentence is now only ever
// shown when the *service* failed, and it says that instead of blaming a number
// the server never had an opinion about.
//
// That is not a disclosure. Every status that reaches this catch block is
// existence-independent by construction — 429 for the caller's own rate limit,
// 503 for a missing secret or a dead database, 403 for the CAPTCHA, and a
// network error for none of the above — so distinguishing "the service failed"
// from "the service answered" cannot reveal which numbers exist.
const LOOKUP_FAIL_TEXT = "Imeshindikana kuangalia namba yako. Tafadhali jaribu tena baadaye.";

function lookupFailureText() {
  return LOOKUP_FAIL_TEXT;
}

// Duplicate-submit guard. A second click landing while the first is still in
// flight would send two lookups for one number, burning two of the five
// attempts the student has this minute and arriving at the same OTP step twice.
// The button is disabled synchronously below, but a queued click event or an
// Enter keypress can still reach this function, so the in-flight flag is the
// real control and the disabled attribute is only the visible half.
let verifyInFlight = false;

async function verifyStep1(ev) {
  if (verifyInFlight) return;

  const btn = ev && ev.currentTarget;
  // The canonical, upper-cased, whitespace-stripped value. Sent to the server
  // rather than the raw field, so a programmatic call with a lower-case or
  // spaced number produces exactly the same request as a typed one.
  let reg = document.getElementById("ver_reg").value.trim();

  // js/verify-ux.js owns the rules for what a valid registration number looks
  // like and how many attempts are left, so the same validation is not kept
  // twice in two files. It has already run the guard on click; this is the
  // backstop for a programmatic call or a paste that landed between renders.
  if (window.RucusoVerify) {
    // A broken or unconfigured CAPTCHA stops here, before the number is even
    // looked at. The reason is already in the console; the student gets one
    // generic sentence.
    if (window.RucusoVerify.captchaFault && window.RucusoVerify.captchaFault()) {
      setVerMark("err");
      document.getElementById("ver1_msg").innerHTML =
        '<p class="err">' + esc(window.RucusoVerify.captchaFaultText()) + "</p>";
      return;
    }
    const check = window.RucusoVerify.validate(reg);
    if (!check.ok) {
      setVerMark("err");
      const m = document.getElementById("ver1_msg");
      // Same two messages as everywhere else — "empty" and the single generic
      // failure. No support links, because attaching them to only some failures
      // is itself a tell.
      m.innerHTML = '<p class="err">'
        + esc(check.code === "empty" ? "Andika namba yako ya usajili." : window.RucusoVerify.FAIL_TEXT)
        + "</p>";
      document.getElementById("ver_reg").focus();
      return;
    }
    reg = check.value;

    // Solved-CAPTCHA backstop. The click guard in verify-ux.js holds the button
    // shut, but this function is also reachable by a queued click, an Enter
    // keypress, or a console call — and without this, a script could skip the
    // widget entirely and spend the server's rate-limit budget. The server would
    // reject the missing token anyway; this stops the request being made.
    //
    // Note the order: the fault check above handles "unconfigured or broken",
    // this handles "configured but not solved". Both fail closed.
    if (window.RucusoVerify.captchaSatisfied && !window.RucusoVerify.captchaSatisfied()) {
      setVerMark("err");
      document.getElementById("ver1_msg").innerHTML =
        '<p class="err">' + esc(window.RucusoVerify.hintText ? window.RucusoVerify.hintText() : window.RucusoVerify.FAIL_TEXT) + "</p>";
      return;
    }

    if (window.RucusoVerify.attemptsLeft() === 0) {
      setVerMark("err");
      const m = document.getElementById("ver1_msg");
      m.innerHTML = '<p class="err">Umefanya majaribio mengi. Subiri sekunda <strong>'
        + window.RucusoVerify.secondsUntilReset() + "</strong> kisha jaribu tena.</p>";
      return;
    }
  }
  const msg = document.getElementById("ver1_msg");
  if (!reg) {
    setVerMark("err");
    msg.innerHTML = '<p class="err">Tafadhali ingiza namba yako ya usajili.</p>';
    return;
  }
  verifyInFlight = true;
  setVerMark("wait");
  msg.innerHTML = '<p class="muted">Inathibitisha.</p>';
  busy(btn, true, "Inathibitisha...");

  // Held for a floor so a fast local response does not render as a one-frame
  // spinner flash and a straight jump to the next screen. This adds no latency
  // to the request itself: the call below is made immediately and the wait only
  // happens after its result has already arrived. All it does is hold the button
  // in its loading state until the floor passes, so the indicator is readable
  // rather than a blink. 1500ms is the figure specified for this form; on a slow
  // connection the real request takes longer and the floor never applies.
  const startedAt = Date.now();
  const MIN_SPIN_MS = 1500;
  // When a CAPTCHA is configured, verify-ux.js stashed the token on the button
  // after the student solved it. It goes to the server for verification there —
  // never trusted on this side. Cleared either way, because a token is
  // single-use and leaving one attached would let the next attempt reuse it.
  const captchaToken = (btn && btn.dataset.captchaToken) || null;
  if (btn) delete btn.dataset.captchaToken;
  try {
    // The existence oracle, and where it lived.
    //
    // This used to call lookupStudentDetailed(), branch on result.found, and
    // advance to the OTP screen only when it was true. That branch was the leak.
    // It did not matter that the response carried no name, no programme and no
    // year, and it did not matter that a determined reader could see the field
    // was gone: reaching step 2 was itself the answer, so a script only had to
    // check which screen it landed on.
    //
    // lookup-student no longer returns an existence field at all — it returns
    // { ok: true } for every registration number — and this function no longer
    // branches. A real number and a made-up one both land on the OTP screen,
    // and neither the response nor the transition distinguishes them. The
    // registration number is carried forward to send-otp, which decides whether
    // a code can be delivered, and that decision is never reported back either.
    await API.lookupRegistrationNumber(reg, captchaToken);
    if (window.RucusoVerify) window.RucusoVerify.resetCaptcha();

    // Held, not branched on. Nothing about this student is known to the page
    // yet — not even that the number is in the registry. The identity arrives
    // from verifyOtp(), after the code has been proved.
    verifyMatch = { reg };
    setVerMark("ok");
    document.getElementById("ver-step1").classList.add("hidden");
    document.getElementById("ver-step2").classList.remove("hidden");
    document.getElementById("ver2_msg").textContent = "";
    document.getElementById("ver2_btn").onclick = sendOtp;
  } catch (e) {
    // Every expected failure renders one sentence. This used to call
    // functionErrorText(e), which mapped NOT_CONFIGURED to a permanent "Huduma
    // ya kuangalia namba ya usajili haijawekwa bado" — a static message that
    // announced the deployment's configuration to every visitor who mistyped a
    // number, and that read as though the form were permanently broken even
    // once the secret was in place.
    //
    // The distinction the student cannot act on is not drawn. Not found, rate
    // limited, wrong format, unconfigured backend and a dropped connection all
    // look identical from outside, which is the point: the difference between
    // them is information about the registry, and a 429 that is distinguishable
    // from a 404 is a free way to find out which numbers exist.
    setVerMark("err");
    msg.innerHTML = `<p class="err">${esc(lookupFailureText())}</p>`;

    // The operator still gets told exactly what broke, in the console, where it
    // cannot be read by the student the message is aimed at. This is the only
    // place the real reason is allowed to appear.
    const code = e && (e.context?.error?.code || e.code || e.statusCode || "");
    console.error("verify: lookup-student failed.", { code, message: e?.message }, e);
    if (code === "NOT_CONFIGURED") {
      console.error(
        "verify: lookup-student returned NOT_CONFIGURED. "
        + "STUDENT_LOOKUP_RATE_LIMIT_SECRET is missing or under 32 characters on the "
        + "Edge Function. supabase secrets set STUDENT_LOOKUP_RATE_LIMIT_SECRET=<32+ chars>"
      );
    }
  } finally {
    // Wait out the remainder of the floor before releasing the button, so the
    // spinner is visible for long enough to register. A no-op once the request
    // has already taken longer than the floor, which is the normal case.
    const remaining = MIN_SPIN_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    verifyInFlight = false;
    busy(btn, false);
  }
}

// There is deliberately no alternative path here any more.
//
// This used to carry confirmPhoneOnFile(): registration number on step 1, phone
// number on file on step 2, identity on the submit screen with no SMS involved.
// It was unreachable while REQUIRE_SMS_OTP was true, and its anon grant was
// revoked in migration 012, so it was already dead — but dead code that
// discloses a student's identity before any OTP is exactly the thing that must
// not be left sitting in a file someone might edit. One flag flip, or one
// well-meaning "let me make the phone step optional", would have reopened the
// oracle the rest of this flow exists to close.
//
// verify_student_identity() is service_role only since migration 012, and
// API.verifyStudentIdentity() no longer exists, so nothing in the browser can
// reach it even by accident.

let otpTimer = null;
async function sendOtp(ev) {
  const btn = ev && ev.currentTarget;
  const emsg = document.getElementById("ver2_msg");
  emsg.textContent = "";
  busy(btn, true, "Inatuma...");
  setVerMark("wait");
  try {
    // One argument, and it is not a phone number.
    //
    // send-otp used to take the number to deliver the SMS to, from the browser.
    // It now takes only the registration number, and sends to whatever is on
    // file. That is the change that closes the oracle no response field could
    // close: a browser-supplied destination lets an attacker submit a guessed
    // registration number together with a phone they own, and read the answer
    // off their own inbox — an identical response body proves nothing when the
    // signal is whether the message arrives.
    //
    // It also means the response carries no information. A real registration
    // number and one belonging to nobody both resolve { ok: true }, so this must
    // not be read as confirmation that a code was sent, and nothing here may
    // branch on the result.
    await API.sendOtp(verifyMatch.reg);
    document.getElementById("ver-step2").classList.add("hidden");
    document.getElementById("ver-step3").classList.remove("hidden");
    document.getElementById("ver3_msg").textContent = "";
    document.getElementById("ver_otp").value = "";
    // still "wait": we are waiting for a code that may or may not be coming.
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
  busy(btn, true, "Inathibitisha...");
  setVerMark("wait");
  try {
    // Keyed on the registration number, not on a phone. The browser no longer
    // holds a phone number at any point in this flow, so there is nothing here
    // that a script could point at a different student with — the code cannot be
    // checked against somebody else's pending row by changing a request field.
    const res = await API.verifyOtp(verifyMatch.reg, code);

    // One rejection for every way it can fail. The server has already collapsed
    // no-pending / expired / exhausted / wrong into a single response, so there
    // is nothing to branch on here either — and nothing to branch on in the old
    // message that used to say "si sahihi", which was chosen to cover the same
    // set. Every one of those was reachable only when a code had actually been
    // issued, which is to say only for a registration number that exists.
    if (!res || res.verified !== true) {
      msg.textContent = OTP_MESSAGES.INVALID_CODE;
      setVerMark("err");
      return;
    }
    setVerMark("ok");
    // First disclosure of the student's identity in the whole flow, and it is
    // earned: the code was just proved. programme/year come from this response
    // rather than from the step-1 lookup, which no longer carries them, and the
    // phone number is returned here for the first time — after the proof, and
    // only to the holder of that phone.
    DB.studentSession = {
      reg: verifyMatch.reg, name: res.full_name || "",
      programme: res.programme || "", year: res.year_of_study || "",
      phone: res.phone_number || "", verifiedAt: new Date().toISOString(), otp_verified: true,
    };
    D.saveStudentSession(DB.studentSession);
    await API.logPublicAction("Student Verification (OTP)", verifyMatch.reg + " — " + (res.phone_number || ""));

    // The one affirmative message in the flow, and the only one that is allowed
    // to mean something. It sits here, after the OTP is proved, rather than on
    // the lookup step: a student who has not yet proved they hold the phone
    // cannot be told their identity is confirmed, and saying so earlier would
    // hand back exactly the existence oracle the rest of the form withholds.
    msg.textContent = VERIFIED_TEXT;
    // ver3_msg ships with class="err" in the markup, so the class is replaced
    // rather than appended — leaving "err" on it would paint a success message
    // in the failure colour.
    msg.className = "ok-msg";

    // Held long enough to be read. The button stays in its busy state for this
    // beat, so the transition reads as spinner → confirmed → next screen rather
    // than a jump cut that skips the one message worth reading.
    await new Promise((r) => setTimeout(r, VERIFIED_HOLD_MS));
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
      // p_student_id stays null on purpose. The browser is not given a students.id
      // by anything it can see — lookup-student returns a boolean and verify-otp
      // returns the name, programme and year, never an id — so the identifying
      // details are carried by the snapshot columns instead.
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
    const completed = rec.status === "Resolved";
    const progressing = ["Under Review", "Assigned", "In Progress", "Awaiting Information"].includes(rec.status);
    const currentStep = completed ? 2 : progressing || ["Closed", "Rejected/Invalid"].includes(rec.status) ? 1 : 0;

    const meta = [
      ["Aina ya maoni", rec.submission_type],
      ["Kundi", rec.category || "—"],
      ["Imetuma", new Date(rec.created_at).toLocaleDateString()],
    ];

    out.innerHTML =
      '<div class="trackresult__head">'
      + '<div><p class="trackresult__ref">' + esc(ref) + '</p>'
      + '<p class="trackresult__status">Hali ya sasa: <span class="pill ' + (STCLASS[rec.status] || "neutral") + '">' + esc(STATUS_LABELS[rec.status] || rec.status) + "</span></p></div>"
      + (progressing ? '<span class="pill info">Inaendelea kushughulikiwa</span>' : "")
      + "</div>"
      + '<dl class="metagrid">' + meta.map(([k, v]) =>
        "<div><dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>").join("") + "</dl>"
      + (rec.response
        ? '<div class="notebox"><p class="notebox__label">Majibu ya msimamizi</p><p>' + esc(rec.response) + "</p></div>"
        : '<p class="muted" style="margin-top:var(--sp-4)">Bado hakuna jibu. Msimamizi atashughulikia maoni yako; unaweza kufuatilia majibu kupitia ukurasa huu.</p>')
      + '<ol class="timeline" aria-label="Hatua za ufuatiliaji">' + steps.map((s, i) => {
        const state = i === 0 ? (currentStep === 0 ? "current" : "done")
          : i === 1 ? (currentStep > 1 ? "done" : currentStep === 1 ? "current" : "todo")
          : completed ? "current" : "todo";
        return '<li class="timeline__item" data-state="' + state + '">'
          + '<span class="timeline__dot">' + (state === "done" ? navIcon("M20 6L9 17l-5-5") : String(i + 1)) + "</span>"
          + '<div><p class="timeline__name">' + esc(s) + "</p>"
          + (i === currentStep ? '<p class="timeline__when">' + esc(STATUS_LABELS[rec.status] || rec.status) + "</p>" : "")
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

// Fallback label map, used only when a leader's position is not one of the
// known posts — the normal path is the label that ships with the row from
// public_leaders (position_label), so this is what you see if a key was renamed
// or a leader was added with a free-text position.
function publicLeaderPosition(position) {
  const labels = {
    president: "Rais",
    vice_president: "Makamu wa Rais",
    secretary_general: "Katibu Mkuu",
    prime_minister: "Waziri Mkuu",
    prime_minister_secretary: "Katibu wa Ofisi ya Waziri Mkuu",
    deputy_secretary_general: "Naibu Katibu Mkuu",
    minister: "Waziri",
    deputy_minister: "Naibu Waziri",
    representative: "Mwakilishi",
    officer: "Afisa",
  };
  return labels[position] || position;
}

// The label to show for a leader, wherever it is being displayed. Prefers the
// label that ships with the row from public_leaders, so renaming a post in
// leadership_positions updates the site without a code change. The hardcoded map
// is only reached if the label is missing (an old row, or free text).
function leaderPositionLabel(leader) {
  if (!leader) return "";
  return leader.position_label || publicLeaderPosition(leader.position);
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
    + '<p class="leadercard__role" style="margin:0 0 var(--sp-3)">' + esc(leaderPositionLabel(l)) + "</p>"
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
    + (s.description ? esc(s.description) : "Maelezo ya huduma yataongezwa hivi karibuni.") + "</p>"
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
    <button type="button" class="servicecard tilt" data-tilt onclick="openService(${i})">
      <span class="servicecard__top">
        <span class="servicecard__icon">${navIcon(serviceIcon(s.name))}</span>
        <span class="servicecard__name">${esc(publicServiceName(s.name))}</span>
      </span>
      <span class="servicecard__desc">${s.description ? esc(s.description) : '<span class="muted">Maelezo ya huduma yataongezwa hivi karibuni.</span>'}</span>
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
  const ticker = document.getElementById("announcementTicker");
  const tickerButton = document.getElementById("tickerAnnouncement");
  if (ticker && tickerButton) {
    ticker.hidden = visible.length === 0;
    if (visible.length) tickerButton.textContent = `${visible[0].title} · ${new Date(visible[0].createdAt).toLocaleDateString("sw-TZ")}`;
  }

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
    await D.refreshHierarchy();
  } catch (e) {
    if (!DB.leaders.length) { fail(grid, e); return; }
  }
  const active = DB.leaders.filter((l) => l.active && l.name);
  visibleLeaders = active;
  const notif = document.getElementById("leaderCount");
  if (notif) notif.textContent = String(active.length);
  grid.innerHTML = active.length ? renderLeaderGrid(active)
    : '<p class="muted" style="grid-column:1/-1">Taarifa za uongozi zitasanidiwa na msimamizi wa mfumo.</p>';
}

// Renders the directory grouped by tier, highest tier first.
//
// The grouping, the order inside each tier and the position labels all come
// from leadership_tiers / leadership_positions (migration 013) rather than from
// an array in this file, so an admin can reorder the structure without a deploy.
// Leaders whose position is not one of the known posts are still listed, under a
// trailing group, rather than being hidden — dropping someone from the public
// directory because a key was renamed would be worse than showing them oddly.
function renderLeaderGrid(leaders) {
  const order = DB.hierarchy.length
    ? [...DB.hierarchy].sort((a, b) => a.tier_rank - b.tier_rank)
    : [];
  const rankOf = new Map(order.map((t) => [t.tier_key, t.tier_rank]));
  const labelOf = new Map(order.map((t) => [t.tier_key, t.tier_label]));

  const card = (l, i) => `
    <button type="button" class="leadercard" onclick="openLeader(${i})">
      <span class="avatar">${l.photo ? '<img src="' + esc(l.photo) + '" alt="" loading="lazy" width="92" height="92">' : navIcon("M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2")}</span>
      <span class="leadercard__name">${esc(l.name)}</span>
      <span class="leadercard__role">${esc(leaderPositionLabel(l))}</span>
      ${l.ministry ? '<span class="leadercard__ministry">' + esc(l.ministry) + "</span>" : ""}
      <span class="leadercard__more">${l.phone ? "Wasiliana" : "Maelezo"} ${navIcon("M5 12h14M13 6l6 6-6 6")}</span>
    </button>`;

  // Sort by tier rank, then position rank, then keep the server's order.
  const sorted = leaders.map((l, i) => ({ l, i })).sort((a, b) => {
    const ra = rankOf.has(a.l.tier_key) ? rankOf.get(a.l.tier_key) : 999;
    const rb = rankOf.has(b.l.tier_key) ? rankOf.get(b.l.tier_key) : 999;
    if (ra !== rb) return ra - rb;
    const pa = a.l.position_rank || 999;
    const pb = b.l.position_rank || 999;
    if (pa !== pb) return pa - pb;
    return a.i - b.i;
  });

  const groups = new Map();
  for (const { l, i } of sorted) {
    const key = l.tier_key || "__other__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card(l, i));
  }

  const section = (key, heading) => {
    const cards = groups.get(key);
    if (!cards || !cards.length) return "";
    return `
      <div class="leadertier">
        <h3 class="leadertier__title">${esc(heading)}</h3>
        <div class="leadgrid">${cards.join("")}</div>
      </div>`;
  };

  let html = "";
  // Declared tiers first, in rank order, even when a tier has nobody in it yet
  // as long as some leader belongs to it.
  for (const t of order) {
    if (groups.has(t.tier_key)) html += section(t.tier_key, t.tier_label);
  }
  if (groups.has("__other__")) {
    html += section("__other__", "Viongozi wengine");
  }
  return html || '<p class="muted">Hakuna viongozi waliomo kwenye mfumo.</p>';
}

// Rebuilds the two dropdowns in the leadership form from the database.
//
// These were free-text inputs, which is what let a leader be filed under a
// position that is not in leadership_positions at all: the text was stored
// verbatim, the hierarchy could not label it, and the leader sorted to the
// bottom of the directory. Both are selects now, so the only values that can be
// chosen are ones the database knows about.
function populateLeaderFormSelects() {
  const pos = document.getElementById("ld_position");
  if (pos) {
    const previous = pos.value;
    pos.innerHTML = '<option value="">Chagua nafasi…</option>';
    DB.positionsByTier().forEach(function (tier) {
      if (!tier.positions.length) return;
      const group = document.createElement("optgroup");
      group.label = tier.label;
      tier.positions.forEach(function (p) {
        const opt = document.createElement("option");
        opt.value = p.key;
        // Posts that need a ministry say so on the option, so it is clear
        // before the ministry field is touched.
        opt.textContent = p.label_sw + (p.ministry_required ? " (inahitaji wizara)" : "");
        group.appendChild(opt);
      });
      pos.appendChild(group);
    });
    if (previous) pos.value = previous;
  }

  const min = document.getElementById("ld_ministry");
  if (min) {
    const previous = min.value;
    min.innerHTML = '<option value="">Bila wizara</option>';
    DB.ministries
      .filter(function (m) { return m.active; })
      .forEach(function (m) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        min.appendChild(opt);
      });
    if (previous) min.value = previous;
  }
}

// Marks the ministry field as required when the chosen post needs one, and
// clears it when the post does not, so the value stored always matches the post.
function syncLegacyMinistryField() {
  const pos = document.getElementById("ld_position");
  const min = document.getElementById("ld_ministry");
  if (!pos || !min) return;
  const p = DB.positions.find(function (x) { return x.key === pos.value; });
  const required = !!(p && p.ministry_required);
  min.required = required;
  min.disabled = false;
  if (!required) min.value = "";
}

function renderLeaderAdmin() {
  populateLeaderFormSelects();
  const el = document.getElementById("leaderAdminList");
  const vacancies = D.vacantSlots();
  const real = DB.leaders.map((l) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${esc(l.position_label || l.position)}${l.ministry ? " (" + esc(l.ministry) + ")" : ""} — ${esc(l.name)}${l.active ? "" : " (imezimwa)"}</span>
      <span><a class="link" onclick="editLeader('${l.id}', event)">Jaza/Hariri</a> &nbsp;<a class="link" onclick="toggleLeaderActive('${l.id}', event)">${l.active ? "Zima" : "Washa"}</a> &nbsp;<a class="link" onclick="removeLeader('${l.id}', event)">Ondoa</a></span>
    </div>`).join("");
  const empty = vacancies.map((v) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <span>${esc(v.position_label || v.position)}${v.ministry ? " (" + esc(v.ministry) + ")" : ""} — <span class="tag">NAFASI WAZI</span></span>
      <span><a class="link" onclick="fillVacancy('${esc(v.position)}','${v.ministry_id || ""}')">Jaza</a></span>
    </div>`).join("");
  el.innerHTML = (real + empty) || '<p class="muted">Hakuna kiongozi bado.</p>';
  syncLegacyMinistryField();
}

function fillVacancy(position, ministryId) {
  document.getElementById("ld_position").value = position;
  // The ministry control is a select of ids now, so the id goes in directly
  // rather than being looked up by name.
  document.getElementById("ld_ministry").value = ministryId || "";
  syncLegacyMinistryField();
  document.getElementById("ld_name").focus();
  document.getElementById("ld_name").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function addLeader(ev) {
  const btn = ev && ev.currentTarget;
  const name = document.getElementById("ld_name").value.trim();
  const position = document.getElementById("ld_position").value.trim();
  if (!name || !position) { D.toast("Weka jina na nafasi ya kiongozi.", "err"); return; }
  const ministryId = document.getElementById("ld_ministry").value;
  const ministry = ministryId ? DB.ministries.find((m) => m.id === ministryId) : null;
  if (ministryId && !ministry) { D.toast("Wizara uliyoweka haipo. Ongeza wizara kwanza kwenye Mipangilio.", "err"); return; }
  // Checked here as well as by the trigger in migration 013, so the reason is
  // shown next to the form instead of arriving as a database error.
  const pos = DB.positions.find((p) => p.key === position);
  if (pos && pos.ministry_required && !ministry) {
    D.toast(`Nafasi "${pos.label_sw}" inahitaji kuteuliwa kwenye wizara.`, "err");
    return;
  }
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
  // The label is shown in the prompt, but the key is what gets saved — the
  // position is not editable here because it is the identity of the row.
  const name = prompt("Jina la kiongozi kwa nafasi '" + (l.position_label || l.position) + "':", l.name);
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
  p.inert = false;
  p.setAttribute("aria-hidden", "false");
  p.setAttribute("aria-modal", "true");
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
  p.setAttribute("aria-hidden", "true");
  p.setAttribute("aria-modal", "false");
  p.inert = true;
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
  // A session stored before OTP became mandatory carries otp_verified:false —
  // it was created by the phone-on-file path, which never sent a code. Those
  // are dropped on load rather than honoured, so turning OTP on actually
  // revokes the weaker sessions that already exist in students' browsers
  // instead of letting them live until their browser storage is cleared.
  DB.studentSession = D.loadStudentSession();
  if (DB.studentSession && REQUIRE_SMS_OTP && DB.studentSession.otp_verified !== true) {
    DB.studentSession = null;
    D.saveStudentSession(null);
  }
  const ui = D.readUI();
  if (ui.theme) document.documentElement.setAttribute("data-theme", ui.theme);
  else document.documentElement.removeAttribute("data-theme");
  const initialTheme = ui.theme || DEFAULT_THEME;
  paintThemeToggle(initialTheme);
  const themeToggle = document.getElementById("themeToggle");
  if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
  updatePortalClock();
  setInterval(updatePortalClock, 1000);
  initHeroCanvas();
  initScrollReveals();
  const ticker = document.getElementById("tickerAnnouncement");
  if (ticker) ticker.addEventListener("click", () => openAnnouncement(0));

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
