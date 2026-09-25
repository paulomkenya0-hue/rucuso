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
const TABS = [
  ["home", "Nyumbani", false], ["submit", "Toa Maoni", false], ["track", "Fuatilia Taarifa", false],
  ["leadership", "Uongozi", false], ["services", "Huduma", false], ["announcements", "Matangazo", false],
  ["documents", "Nyaraka", false],
  ["dashboard", "Dashibodi", true], ["issues", "Masuala", true], ["reports", "Ripoti", true],
  ["settings", "Mipangilio", true], ["adminlogin", "Ingia (Msimamizi)", false],
];
let currentView = "home";
let verifyTarget = { preset: null };

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = "";
  TABS.forEach(([id, label, needsAuth]) => {
    if (needsAuth && !DB.session) return;
    if (id === "adminlogin" && DB.session) return;
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => go(id);
    b.className = id === currentView ? "active" : "";
    nav.appendChild(b);
  });
  if (DB.session) {
    const b = document.createElement("button");
    b.textContent = "Logout (" + String(DB.session.role).replace(/_/g, " ") + ")";
    b.onclick = logout;
    nav.appendChild(b);
  }
  document.getElementById("loginState").textContent =
    DB.session ? "Logged in: " + DB.session.name : "";
}

function go(id, presetType) {
  if (["dashboard", "issues", "reports", "settings"].includes(id) && !DB.session) id = "adminlogin";
  if (id === "submit" && !DB.studentSession) { verifyTarget = { preset: presetType || null }; id = "verify"; }
  currentView = id;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + id).classList.add("active");
  renderTabs();

  if (id === "verify") {
    ["ver-step1", "ver-step2", "ver-step3"].forEach((s, i) =>
      document.getElementById(s).classList.toggle("hidden", i !== 0));
    document.getElementById("ver_reg").value = "";
    document.getElementById("ver1_msg").innerHTML = "";
    document.getElementById("ver2_msg").textContent = "";
    document.getElementById("ver3_msg").textContent = "";
  }
  if (id === "submit") {
    populateCategories();
    newCaptcha();
    document.getElementById("successCard").classList.add("hidden");
    document.getElementById("regLookupMsg").textContent = "";
    document.getElementById("f_name").readOnly = false;
    if (DB.studentSession) {
      const s = DB.studentSession;
      document.getElementById("verifiedBanner").classList.remove("hidden");
      document.getElementById("vb_name").textContent = s.name;
      document.getElementById("vb_reg").textContent = s.reg;
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
      document.getElementById("f_type").value = presetType;
    }, 0);
  }
  if (id === "leadership") renderLeadership();
  if (id === "services") renderServices();
  if (id === "announcements") renderAnnouncements();
  if (id === "documents") renderDocuments();
  if (id === "dashboard") renderDashboard();
  if (id === "issues") renderIssues();
  if (id === "settings") renderSettings();
  window.scrollTo(0, 0);
}

document.addEventListener("change", (e) => {
  if (e.target.id === "f_anon") {
    document.getElementById("identBlock").classList.toggle("hidden", e.target.checked);
  }
});

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
let verifyMatch = null;
async function verifyStep1(ev) {
  const btn = ev && ev.currentTarget;
  const reg = document.getElementById("ver_reg").value.trim();
  const msg = document.getElementById("ver1_msg");
  if (!reg) { msg.innerHTML = '<p class="err">Tafadhali ingiza namba yako ya usajili.</p>'; return; }
  busy(btn, true, "Inathibitisha...");
  try {
    const match = await API.lookupStudent(reg);
    if (!match) {
      msg.innerHTML = '<p class="err">Samahani, Namba hii ya Usajili haijapatikana kwenye mfumo.</p>'
        + '<button class="sec" style="background:var(--navy2);" onclick="verifyStep1(event)">Jaribu tena</button> '
        + '<button class="sec" style="background:var(--navy2);" onclick="openAI()">Wasiliana na RUCUSO</button>';
      return;
    }
    verifyMatch = {
      reg, name: match.full_name,
      programme: match.programme || "", year: match.year_of_study || "",
    };
    document.getElementById("ver_name").textContent = verifyMatch.name;
    document.getElementById("ver_prog").textContent = verifyMatch.programme || "—";
    document.getElementById("ver_year").textContent = verifyMatch.year ? "Mwaka wa " + verifyMatch.year : "—";
    document.getElementById("ver-step1").classList.add("hidden");
    document.getElementById("ver-step2").classList.remove("hidden");
  } catch (e) {
    msg.innerHTML = `<p class="err">${esc(D.errText(e))}</p>`;
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
  try {
    await API.sendOtp(norm, verifyMatch.reg);
    document.getElementById("ver_phone_out").textContent = norm;
    document.getElementById("ver-step2").classList.add("hidden");
    document.getElementById("ver-step3").classList.remove("hidden");
    document.getElementById("ver3_msg").textContent = "";
    document.getElementById("ver_otp").value = "";
    startResendTimer();
  } catch (e) {
    emsg.textContent = await functionErrorText(e);
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
  if (!/^\d{6}$/.test(code)) { msg.textContent = "Namba ya uthibitisho lazima iwe tarakimu 6."; return; }
  const phone = normalizeTzPhone(document.getElementById("ver_phone").value);
  busy(btn, true, "Inathibitisha...");
  try {
    const res = await API.verifyOtp(phone, code);
    if (!res || !res.verified) { msg.textContent = "Namba ya uthibitisho si sahihi."; return; }
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
  if (!title || !desc) { err.textContent = "Subject and description are required."; return; }
  if (+document.getElementById("captchaAns").value !== captchaAnswer) {
    err.textContent = "Incorrect answer to the verification question above."; return;
  }
  const anon = document.getElementById("f_anon").checked;
  const name = document.getElementById("f_name").value.trim();
  const reg = document.getElementById("f_reg").value.trim();
  if (!anon && (!name || !reg)) {
    err.textContent = "Please provide at least your name and registration number, or choose anonymous."; return;
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
      if (file.size > 1024 * 1024) { err.textContent = "Attachment is too large (maximum 1MB)."; return; }
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
  if (!ref) { out.innerHTML = '<p class="err">Tafadhali ingiza reference number.</p>'; return; }
  busy(btn, true, "Inatafuta...");
  out.innerHTML = '<p class="muted">Inatafuta...</p>';
  try {
    const rec = await API.trackFeedback(ref);
    if (!rec) {
      out.innerHTML = '<p class="err">No submission found for that reference number.</p>';
      return;
    }
    const steps = TRACK_STEPS;
    let idx = steps.indexOf(rec.status);
    if (idx < 0) idx = ["Closed", "Rejected/Invalid"].includes(rec.status) ? 3
      : rec.status === "Assigned" || rec.status === "Awaiting Information" ? 1 : 0;
    out.innerHTML = `
      <p><b>Submission Type:</b> ${esc(rec.submission_type)}</p>
      <p><b>Category:</b> ${esc(rec.category || "—")}</p>
      <p><b>Date Submitted:</b> ${new Date(rec.created_at).toLocaleDateString()}</p>
      <p><b>Current Status:</b> <span class="pill ${STCLASS[rec.status] || ""}">${esc(rec.status)}</span></p>
      <p><b>Latest Response:</b> ${rec.response ? esc(rec.response) : '<span class="muted">No response yet.</span>'}</p>
      <div class="muted" style="margin-top:8px;">${steps.map((s, i) => (i <= idx ? "✓ " : "○ ") + s).join("&nbsp;&nbsp;")}</div>`;
  } catch (e) {
    fail(out, e);
  } finally {
    busy(btn, false);
  }
}

// ---------- Admin auth ----------
async function doLogin(ev) {
  const u = document.getElementById("loginUser").value.trim();
  const p = document.getElementById("loginPass").value;
  const err = document.getElementById("loginErr");
  const btn = ev && ev.currentTarget;
  err.textContent = "";
  if (!u || !p) { err.textContent = "Tafadhali ingiza barua pepe na nenosiri."; return; }
  busy(btn, true, "Inaingia...");
  try {
    const s = await API.adminLogin(u, p);
    await D.setSession(s);
    await D.loadAdmin();
    document.getElementById("loginPass").value = "";
    go("dashboard");
  } catch (e) {
    err.textContent = D.errText(e);
  } finally {
    busy(btn, false);
  }
}

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

function closeIssue() { document.getElementById("issueModalBg").classList.remove("active"); }

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
  document.getElementById("docUploadCard").classList.toggle("hidden", !DB.session);
  D.loading(list, "Inapakia nyaraka...");
  try {
    await D.refreshDocuments();
  } catch (e) { fail(list, e); return; }
  list.innerHTML = DB.documents.length ? DB.documents.map((d) => `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
      <div><b>${esc(d.title)}</b><br><span class="muted" style="font-size:12px;">${esc(d.category || "Hati")} · ${new Date(d.uploadedAt).toLocaleDateString()}</span></div>
      <div><a class="link" href="${esc(d.url)}" target="_blank" rel="noopener" download>Pakua</a>${DB.session ? ` &nbsp;<a class="link" onclick="removeDocument('${d.id}', event)">Ondoa</a>` : ""}</div>
    </div>`).join("") : '<p class="muted">Hakuna nyaraka zilizopakiwa bado.</p>';
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
  D.loading(grid, "Inapakia huduma...");
  try {
    await D.refreshServices();
  } catch (e) { fail(grid, e); return; }
  const active = DB.services.filter((s) => s.active);
  grid.innerHTML = active.length ? active.map((s) => `
    <div class="card"><h3>${esc(s.name)}</h3>
      <p style="font-size:13px;">${s.description ? esc(s.description) : '<span class="muted">Maelezo bado hayajawekwa na msimamizi.</span>'}</p>
      ${s.contact ? `<p class="muted" style="font-size:12px;">Mawasiliano: ${esc(s.contact)}</p>` : ""}
    </div>`).join("") : '<p class="muted">Huduma zitasanidiwa hivi karibuni na msimamizi wa mfumo.</p>';
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
  const grid = document.getElementById("annGrid");
  document.getElementById("annCreateCard").classList.toggle("hidden", !DB.session);
  if (!document.getElementById("an_publish").value) document.getElementById("an_publish").value = todayISO();
  D.loading(grid, "Inapakia matangazo...");
  try {
    await D.refreshAnnouncements();
  } catch (e) { fail(grid, e); return; }
  const today = todayISO();
  const visible = DB.announcements
    .filter((a) => (!a.publishDate || a.publishDate <= today) && (!a.expiryDate || a.expiryDate >= today))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  grid.innerHTML = visible.length ? visible.map((a) => `
    <div class="card">
      <h3 style="margin:0 0 4px;">${esc(a.title)}</h3>
      <p class="muted" style="font-size:12px;margin:0 0 8px;">${a.category ? esc(a.category) + " · " : ""}${esc(a.audience)} · ${new Date(a.createdAt).toLocaleDateString()}${DB.session ? ` &nbsp;<a class="link" onclick="removeAnnouncement('${a.id}', event)">Ondoa</a>` : ""}</p>
      <p style="font-size:13px;">${esc(a.description)}</p>
    </div>`).join("") : '<p class="muted">Hakuna matangazo kwa sasa.</p>';
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
  D.loading(grid, "Inapakia viongozi...");
  try {
    await D.refreshLeaders();
  } catch (e) { fail(grid, e); return; }
  const active = DB.leaders.filter((l) => l.active && l.name);
  grid.innerHTML = active.length ? active.map((l) => `
    <div class="card" style="text-align:center;">
      ${l.photo ? `<img src="${esc(l.photo)}" style="width:84px;height:84px;border-radius:50%;object-fit:cover;margin-bottom:8px;">`
        : `<div style="width:84px;height:84px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;margin:0 auto 8px;font-size:28px;">👤</div>`}
      <h3 style="margin:4px 0 0;">${esc(l.name)}</h3>
      <p class="muted" style="margin:2px 0 8px;">${esc(l.position)}${l.ministry ? " · " + esc(l.ministry) : ""}</p>
      <p style="font-size:13px;">${esc(l.bio)}</p>
      ${l.phone ? `<a class="pri" style="display:inline-block;text-decoration:none;margin-top:6px;" href="tel:${esc(l.phone)}">📞 Wasiliana (${esc(l.phone)})</a>` : '<p class="muted">Namba ya simu haijawekwa.</p>'}
    </div>`).join("") : '<p class="muted">Taarifa za uongozi zitasanidiwa na msimamizi wa mfumo.</p>';
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
  document.getElementById("aiModalBg").classList.add("active");
  if (!document.getElementById("aiChat").innerHTML) {
    addAI("Habari! Mimi ni RUCUSO AI, msaidizi wa mfumo. Naweza kukusaidia kutumia RUCUSO, kueleza huduma zilizo kwa wanafunzi, kutangaza uongozi, na (kwa wasimamizi) kupewa muhtasari wa ripoti. Uliza chochote kwa lugha yako - mfano: 'Nianzie wapi?' au 'Nawezaje kuwasilisha malalamiko yangu?'");
    document.getElementById("aiInput").focus();
  }
}
function closeAI() { document.getElementById("aiModalBg").classList.remove("active"); }
function addAI(text, who) {
  const c = document.getElementById("aiChat");
  const line = document.createElement("div");
  line.className = "chatline";
  const b = document.createElement("b");
  b.textContent = (who || "RUCUSO AI") + ":";
  line.appendChild(b);
  // textContent, not innerHTML: the answer is model output and must never be
  // interpreted as markup. pre-wrap keeps the numbered lists readable.
  line.appendChild(document.createTextNode(" " + String(text == null ? "" : text)));
  line.style.whiteSpace = "pre-wrap";
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
  D.purgePrototypeStorage();
  DB.studentSession = D.loadStudentSession();
  const ui = D.readUI();
  if (ui.theme) document.documentElement.setAttribute("data-theme", ui.theme);

  if (!API) {
    document.getElementById("view-home").innerHTML =
      '<div class="card"><h2 style="margin-top:0">Mfumo haujaunganishwa na database</h2>'
      + '<p class="err">Haipatikani taarifa za muunganisho wa Supabase. Tafadhali wasiliana na msimamizi wa mfumo.</p></div>';
    renderTabs();
    return;
  }

  try {
    const s = await API.currentSession();
    if (s) await D.setSession(s);
  } catch (_) { /* not signed in / offline: continue as visitor */ }

  try {
    await D.loadPublic();
    DB.ready = true;
  } catch (e) {
    D.toast(D.errText(e), "err");
  }

  renderTabs();
  go("home");
  if (DB.session) {
    try { await D.loadAdmin(); } catch (e) { D.toast(D.errText(e), "err"); }
  }
}

boot();
