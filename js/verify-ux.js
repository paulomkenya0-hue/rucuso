// RUCUSO — RucusoVerify
//
// Loaded on the home page after js/app.js. Input validation, attempt limiting
// and CAPTCHA for the identity verification form (#ver-step1).
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// This is entirely a client-side *experience* layer. It stops a typo, stops a
// student hammering the button, and makes an obvious bot's job slightly harder.
// It is not a security control, and nothing here should be trusted to stop
// anyone. Anyone can open devtools and call the Edge Function directly.
//
// The actual controls are server-side and already in place:
//   * lookup-student returns a bare boolean, never identity.
//   * It is rate limited per registration number (20 / 10 min) and per client
//     address (60 / 10 min), HMAC-keyed so the ledger holds no plaintext.
//   * Identity is released only by verify-otp, after a code sent to the phone
//     on file is proved.
//
// So the limit here is deliberately small and deliberately blunt, and it never
// gets in the way of a student who has made a mistake.
//
// REGISTRATION NUMBER FORMAT — READ BEFORE CHANGING validate()
//
// Current official format, as specified:
//
//     RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>
//     RU/BAFIT/2024/007, RU/BIT/2023/123, RU/BBA/2025/001
//
// so the accepted shape is exactly NEW_RE below and nothing else.
//
// LEGACY_RE is NOT a second way in. It exists for one purpose: to recognise a
// number in the pre-2026 format (RUCU/2024/01) so the student can be told what
// happened to them, instead of being handed the same "not found" message they
// would get for a number that was simply typed wrong. See legacyMessage().
//
// The course-code segment is the reason this is a schema change and not a
// validation tweak: the students table has no course_code column, so there is
// nothing to migrate old numbers *from*. Migration 014 adds the column and the
// backfill; the course code for each existing student has to be supplied by
// someone who knows it, because it cannot be derived from programme or faculty
// (both are free text and neither contains a course code).
(function () {
  "use strict";

  // The official format. Applied case-insensitively, but the value is
  // upper-cased on the way in, so what is stored and sent is always canonical.
  var NEW_RE = /^RU\/[A-Z]{2,6}\/\d{4}\/\d{3,4}$/i;

  // The pre-2026 shape, recognised only so it can be reported specifically.
  // Deliberately never used to authorise a lookup.
  var LEGACY_RE = /^[A-Z]{2,6}\s*\/\s*\d{2,4}\s*\/\s*\d{1,6}$/i;

  // "RU/ABCDEF/2024/007" — the longest number the official format can produce.
  var MAX_LEN = 24;

  // 5 attempts a minute. Generous enough that a student fixing a typo twice
  // never notices, small enough that a script gets nowhere.
  var MAX_ATTEMPTS = 5;
  var WINDOW_MS = 60_000;

  // Kept in sessionStorage, not localStorage: it should not follow the student
  // to another tab or survive the tab being reopened tomorrow.
  var STORE = "rucuso_verify_attempts";

  function store() {
    try {
      return window.sessionStorage;
    } catch (_) {
      // Private browsing, or storage disabled. Degrade to an in-memory counter
      // rather than letting the whole form break.
      return null;
    }
  }

  var memory = [];

  function readAttempts() {
    var s = store();
    if (s) {
      try {
        var raw = s.getItem(STORE);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.filter(function (t) { return typeof t === "number"; });
        }
      } catch (_) { /* corrupt or unreadable: start clean */ }
    }
    return memory.slice();
  }

  function writeAttempts(list) {
    var s = store();
    if (s) {
      try { s.setItem(STORE, JSON.stringify(list)); } catch (_) { /* full: fall back to memory */ }
    }
    memory = list.slice();
  }

  function prune(list) {
    var cutoff = Date.now() - WINDOW_MS;
    return list.filter(function (t) { return t > cutoff; });
  }

  function attemptsLeft() {
    return Math.max(0, MAX_ATTEMPTS - prune(readAttempts()).length);
  }

  function secondsUntilReset() {
    var list = prune(readAttempts());
    if (list.length < MAX_ATTEMPTS) return 0;
    var oldest = Math.min.apply(null, list);
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - Date.now()) / 1000));
  }

  function recordAttempt() {
    var list = prune(readAttempts());
    list.push(Date.now());
    writeAttempts(list);
  }

  // ---- the check -----------------------------------------------------------

  // Strips whitespace and forces upper case. Every other path in the app sends
  // the canonical form, so the rate-limit bucket and the LIKE pattern are the
  // same regardless of how it was typed or pasted.
  function canonical(raw) {
    return String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, "");
  }

  // Whitespace-tolerant version, for matching only. Lets a pasted
  // "RU / BAFIT / 2024 / 007" through without rejecting it over spaces.
  function loose(raw) {
    return String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s*([\/\-])\s*/g, "$1");
  }

  // Returns { ok, value, code, message }. `code` is one of:
  //   ok | empty | too-long | legacy | shape
  // `value` is the canonical number, safe to send, but only meaningful when ok.
  //
  // `code` is for the form's own logic and for logging, never for display — see
  // FAIL_TEXT. Every failure below returns the same message.
  function validate(raw) {
    var value = canonical(raw);
    var spaced = loose(raw);

    if (!value) {
      return { ok: false, value: "", code: "empty", message: "" };
    }
    if (value.length > MAX_LEN) {
      return { ok: false, value: value, code: "too-long", message: FAIL_TEXT };
    }
    if (NEW_RE.test(spaced)) {
      return { ok: true, value: spaced, code: "ok", message: "" };
    }
    if (LEGACY_RE.test(spaced)) {
      return { ok: false, value: value, code: "legacy", message: FAIL_TEXT };
    }
    return { ok: false, value: value, code: "shape", message: FAIL_TEXT };
  }

  // One message for every failure. Malformed, pending-migration and genuinely
  // unknown are deliberately indistinguishable.
  //
  // This is a real reduction in what the form leaks: previously a student whose
  // record was merely unmigrated got a different sentence from someone who had
  // typed a wrong number, which meant a script could tell "real student, not
  // migrated" from "no such student" and keep going. Now every negative looks
  // identical, and the only signal left is the rate limit — which is the one
  // that is supposed to be the control.
  //
  // The cost is real and worth stating: a student with an unmigrated number now
  // has to ask the office rather than being told what is wrong. That is the
  // trade, and it is the right side of it — a wrong "your number does not
  // exist" is worse than a support call, and the migration worklist in
  // migration 014 is what actually clears the queue.
  var FAIL_TEXT = "Namba ya usajili sio sahihi au haijapatikana.";

  // There is deliberately no legacyMessage(). A function of that name implied a
  // separate sentence for the pre-2026 shape, and every caller that could have
  // used it now renders FAIL_TEXT instead. If a future need appears for a
  // migration-specific message, it belongs in an operator-only surface such as
  // the Edge Function log — not in a value the browser can read.

  // ---- CAPTCHA -------------------------------------------------------------


  // ---- CAPTCHA -------------------------------------------------------------

  // Cloudflare Turnstile, loaded on demand and only if a site key is configured.
  //
  // If it IS enabled, the token is not trusted here: it is handed to
  // lookup-student, which verifies it against the server-side secret. A token
  // checked only in the browser is a checkbox, not a CAPTCHA.
  var TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var captchaWidget = null;
  var captchaToken = null;
  // Set when Turnstile was expected but could not be used: no site key, or the
  // CDN could not be reached. Distinct from "not solved yet", because the two
  // need different words and only one of them is actionable by the student.
  var captchaFault = "";

  function siteKey() {
    var cfg = window.RUCUSO_CONFIG || {};
    return cfg.TURNSTILE_SITE_KEY || "";
  }

  function isCaptchaEnabled() {
    return !!siteKey();
  }

  // Shown to the student when the CAPTCHA cannot run at all. Deliberately says
  // nothing about why: whether the key is unset, the CDN is blocked or the
  // widget threw is an operator fact, and a student cannot act on any of it.
  // The real reason goes to the console.
  var CAPTCHA_FAULT_TEXT = "Uthibitisho wa usalama haupatikani kwa sasa. Tafadhali jaribu tena baadaye.";

  function captchaFaultText() {
    return CAPTCHA_FAULT_TEXT;
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = TURNSTILE_SRC;
      el.async = true;
      el.defer = true;
      el.onload = function () { resolve(window.turnstile); };
      el.onerror = function () { reject(new Error("turnstile failed to load")); };
      document.head.appendChild(el);
    });
  }

  function ensureCaptcha() {
    if (!isCaptchaEnabled()) {
      // No site key. This used to be a silent pass-through, which meant a
      // deployment that forgot the key ran with no CAPTCHA at all while the
      // button behaved exactly as though one had been solved. Fail closed
      // instead: the button stays disabled and the student is told the security
      // check is unavailable.
      captchaFault = "no-site-key";
      console.error(
        "verify: TURNSTILE_SITE_KEY is not set, so the CAPTCHA gate is disabled. "
        + "Set it in supabase/config.js and redeploy. Until then verification is "
        + "intentionally blocked rather than left unguarded."
      );
      setButtonState();
      return Promise.resolve(null);
    }
    if (captchaWidget) return Promise.resolve(captchaWidget);

    var mount = document.getElementById("verCaptcha");
    if (!mount) return Promise.resolve(null);

    return loadTurnstile().then(function (turnstile) {
      if (!turnstile) return null;
      // Locked to one key per render, not to the host page, so a student cannot
      // drag the widget off the form.
      captchaWidget = turnstile.render(mount, {
        sitekey: siteKey(),
        theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
        callback: function (token) {
          captchaToken = token;
          captchaFault = "";
          // The button is gated on the CAPTCHA as well as the number, so solving
          // the widget has to re-run the gate. Without this the button would
          // stay greyed out forever on a correctly-formatted number.
          setButtonState();
        },
        "expired-callback": function () { captchaToken = null; setButtonState(); },
        "error-callback": function () { captchaToken = null; setButtonState(); },
      });
      return captchaWidget;
    }).catch(function (error) {
      // Cloudflare is unreachable. The old behaviour was to fall through to
      // server-side rate limiting, which kept the form usable — but it also let
      // a deployment that had been configured for a CAPTCHA run without one.
      // Rate limiting still applies; it is just not a substitute for the check
      // the deployment asked for, so the button stays locked and the reason goes
      // to the console.
      captchaFault = "load-failed";
      console.error("verify: Turnstile failed to load:", error && error.message);
      setButtonState();
      return null;
    });
  }

  function captchaTokenValue() {
    if (!isCaptchaEnabled()) return null;
    return captchaToken;
  }

  function resetCaptcha() {
    if (captchaWidget && window.turnstile) {
      try { window.turnstile.reset(captchaWidget); } catch (_) { /* gone already */ }
    }
    captchaToken = null;
  }

  // ---- escaping ------------------------------------------------------------
  // Kept even though supportHtml is gone: every message the form renders goes
  // through esc(), and the value under test is attacker-influenced input.

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // ---- the CAPTCHA gate ----------------------------------------------------

  // The button is only enabled when the number is valid AND the CAPTCHA is
  // satisfied.
  //
  // Fails closed. An earlier version returned true when no site key was
  // configured, on the reasoning that the button would otherwise never enable on
  // a fresh deployment. The cost of that choice was that a deployment which
  // simply forgot the key ran with no CAPTCHA at all and nothing on the page
  // said so — the button looked exactly as it does when a CAPTCHA is working.
  // "Usable but unguarded" is the worse failure for a system whose only job is
  // to decide who may claim a student identity, so a missing or broken CAPTCHA
  // now locks the button and says so generically.
  function captchaSatisfied() {
    if (!isCaptchaEnabled()) return false;
    if (captchaFault) return false;
    return !!captchaToken;
  }

  // ---- the form -------------------------------------------------------------

  var els = {};
  var countdownTimer = null;

  function el(id) { return document.getElementById(id); }

  function cache() {
    els.input = el("ver_reg");
    els.button = el("ver1_btn");
    els.limit = el("ver1_limit");
    els.hint = el("ver1_hint");
  }

  // Computes the button's enabled state and the hint text. Deliberately does
  // NOT call renderLimit().
  //
  // This split exists because of a real crash. setButtonState() used to end by
  // calling renderLimit(), and renderLimit() called setButtonState() back when
  // there was no countdown to show — which is the steady state before the first
  // attempt. So every call went setButtonState -> renderLimit -> setButtonState
  // -> ... until the stack ran out. The page threw on init, before a student
  // could type anything.
  //
  // The one-way flow now: setButtonState() -> applyGate() + renderLimit(), and
  // renderLimit() -> applyGate() when a countdown expires. No cycle.
  function applyGate() {
    if (!els.input || !els.button) return;
    var result = validate(els.input.value);
    var left = attemptsLeft();

    // Three independent reasons the button can be off. Each is explained where
    // it is visible rather than leaving the student to guess at a grey button.
    var captchaOk = captchaSatisfied();
    els.button.disabled = !(result.ok && left > 0 && captchaOk);

    // Deliberately no success message and no character counter.
    //
    // Both were leaks. A live "17 / 24" counter plus a "namba inaonekana
    // sahihi" confirmation is a free oracle: it tells an attacker that a
    // guessed string is the right length and the right general shape before a
    // single request is sent, which is exactly the feedback a script needs to
    // search the space. The only states worth speaking are the ones the student
    // cannot otherwise act on — an unsolved CAPTCHA, or an exhausted budget.
    if (els.hint) {
      // Note what is deliberately absent: a condition on result.ok.
      //
      // An earlier version showed the CAPTCHA prompt only when the number was
      // well-formed, which made the hint's mere presence a format oracle — watch
      // whether #ver1_hint had text and you learned whether the shape matched,
      // with no request sent. Each state below is therefore keyed on the thing
      // it actually describes and nothing else, so the hint says the same thing
      // for a number that is right and a number that is not.
      if (captchaFault) {
        els.hint.textContent = captchaFaultText();
        els.hint.className = "fhint fhint--warn";
      } else if (!captchaOk) {
        els.hint.textContent = "Thibitisha kwamba wewe ni mtu ili kuendelea.";
        els.hint.className = "fhint fhint--warn";
      } else if (left === 0) {
        els.hint.textContent = "Subiri sekunda " + secondsUntilReset() + " kisha jaribu tena.";
        els.hint.className = "fhint fhint--warn";
      } else {
        els.hint.textContent = "";
        els.hint.className = "fhint";
      }
    }
  }

  function setButtonState() {
    applyGate();
    renderLimit();
  }

  function renderLimit() {
    if (!els.limit) return;
    var secs = secondsUntilReset();
    if (!secs) {
      els.limit.innerHTML = "";
      els.limit.hidden = true;
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      // applyGate, not setButtonState — see the note on applyGate about the
      // recursion this used to cause.
      applyGate();
      return;
    }
    els.limit.hidden = false;
    var count = els.limit.querySelector(".ratelimit__count");
    if (count) count.textContent = String(secs);
    if (!countdownTimer) {
      countdownTimer = setInterval(function () {
        var s = secondsUntilReset();
        var c = els.limit && els.limit.querySelector(".ratelimit__count");
        if (!s) { clearInterval(countdownTimer); countdownTimer = null; renderLimit(); return; }
        if (c) c.textContent = String(s);
        else renderLimit();
      }, 1000);
    }
  }

  // Runs before the real submit. Returns false to stop it.
  function guard(event) {
    var result = validate(els.input.value);
    var msg = el("ver1_msg");

    // The CAPTCHA is checked first. If it is broken there is no honest way to
    // continue, and reporting on the number first would tell a student their
    // number is good immediately before refusing to look it up.
    if (captchaFault) {
      if (msg) msg.innerHTML = '<p class="err">' + esc(captchaFaultText()) + "</p>";
      return false;
    }

    if (!result.ok) {
      // Only the empty case is worth a word. Every other failure gets the same
      // generic sentence, because a specific message is an oracle: it tells a
      // script which part of its guess was wrong.
      if (msg) {
        msg.innerHTML = result.code === "empty"
          ? '<p class="err">Andika namba yako ya usajili.</p>'
          : '<p class="err">' + esc(result.message) + "</p>";
      }
      els.input.focus();
      return false;
    }

    // Regex alone is not enough to submit once a CAPTCHA is configured — the
    // token has to have been solved. Checked here as well as in
    // setButtonState, so a keyboard Enter or a programmatic call cannot skip it.
    if (!captchaSatisfied()) {
      if (msg) {
        msg.innerHTML = '<p class="err">Thibitisha kwamba wewe ni mtu ili kuendelea.</p>';
      }
      return false;
    }

    if (attemptsLeft() === 0) {
      var secs = secondsUntilReset();
      if (msg) {
        // No support links here. Offering them only on a rate-limit tells a
        // script it hit a real, counted limit rather than a rejected format.
        msg.innerHTML =
          '<p class="err">Umefanya majaribio mengi. Subiri sekunda <strong>' + secs +
          "</strong> kisha jaribu tena.</p>";
      }
      renderLimit();
      return false;
    }

    // Normalise what the rest of the flow will send: upper case, no spaces. The
    // server matches case-insensitively anyway, but sending one canonical form
    // means the rate-limit bucket is the same whichever way it was typed.
    els.input.value = result.value;
    recordAttempt();
    renderLimit();
    return true;
  }

  // Forces upper case as the student types.
  //
  // Assigning input.value moves the caret to the end of the field, which makes
  // typing in the middle of a number impossible — so the selection is captured
  // first and put back. Upper-casing never changes the string length, so the
  // offsets stay valid and the caret lands exactly where it was.
  function forceUpper(input) {
    var before = input.value;
    if (before === before.toUpperCase()) return;

    var start = input.selectionStart;
    var end = input.selectionEnd;
    var after = before.toUpperCase();

    input.value = after;
    if (start != null && end != null) {
      try { input.setSelectionRange(start, end); } catch (_) { /* type has no selection */ }
    }
  }

  function onInput() {
    forceUpper(els.input);
    setButtonState();

    // Clear a stale error as soon as the student starts fixing it, but do not
    // clear it mid-keystroke into another invalid value.
    var msg = el("ver1_msg");
    if (msg && msg.innerHTML && validate(els.input.value).ok) msg.innerHTML = "";
  }

  function init() {
    cache();
    if (!els.input || !els.button) return;

    ensureCaptcha();

    els.input.addEventListener("input", onInput);

    // A paste of a lowercase or spaced number should be normalised immediately,
    // not only once the student edits it by hand.
    els.input.addEventListener("paste", function () {
      // Deferred to the end of the current task so the pasted text is in the
      // field before it is normalised.
      setTimeout(function () { forceUpper(els.input); setButtonState(); }, 0);
    });

    // The button is the real submitter, so the guard runs on click and also on
    // Enter from within the field.
    els.button.addEventListener("click", function (event) {
      if (!guard(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Only now is the CAPTCHA token meaningful: it was just solved.
      var token = captchaTokenValue();
      if (token) {
        // Handed to the Edge Function, which verifies it server-side.
        els.button.dataset.captchaToken = token;
        resetCaptcha();
      }
    });

    els.input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        if (!els.button.disabled) els.button.click();
      }
    });

    // No delegated handler and no toggle: the reveal control is gone, so there is
    // no format to toggle. A student who cannot recall the number has to ask the
    // office.

    setButtonState();
  }

  // Public surface, so app.js can consume the same validation and the same
  // attempt budget rather than keeping a second copy of the rules.
  window.RucusoVerify = {
    init: init,
    validate: validate,
    guard: guard,
    attemptsLeft: attemptsLeft,
    secondsUntilReset: secondsUntilReset,
    isCaptchaEnabled: isCaptchaEnabled,
    captchaSatisfied: captchaSatisfied,
    captchaFault: function () { return captchaFault; },
    captchaFaultText: captchaFaultText,
    ensureCaptcha: ensureCaptcha,
    captchaToken: captchaTokenValue,
    resetCaptcha: resetCaptcha,
    setButtonState: setButtonState,
    NEW_RE: NEW_RE,
    MAX_LEN: MAX_LEN,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    WINDOW_MS: WINDOW_MS,
    FAIL_TEXT: FAIL_TEXT,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
