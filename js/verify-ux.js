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

  var EXAMPLE = "RU/BAFIT/2024/007";

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
  // `message` is Kiswahili and shown under the field. `value` is the canonical
  // number, safe to send, but only meaningful when ok is true.
  function validate(raw) {
    var value = canonical(raw);
    var spaced = loose(raw);

    if (!value) {
      return { ok: false, value: "", code: "empty", message: "Andika namba yako ya usajili." };
    }
    if (value.length > MAX_LEN) {
      return {
        ok: false, value: value, code: "too-long",
        message: "Namba hii ni ndefu mno. Tarakimu " + MAX_LEN + " au kidogo.",
      };
    }
    if (NEW_RE.test(spaced)) {
      return { ok: true, value: spaced, code: "ok", message: "" };
    }
    if (LEGACY_RE.test(spaced)) {
      return { ok: false, value: value, code: "legacy", message: legacyMessage() };
    }
    return {
      ok: false, value: value, code: "shape",
      message: "Namba ya usajili lazima iwe RU/KODI/2024/NUMIA — mfano " + EXAMPLE + ".",
    };
  }

  // Said only when the number is structurally a registration number but not in
  // the current format. This is a different problem from a typo and deserves a
  // different answer: the student's record exists, it just has not been
  // migrated, and only the registry office can supply the course code.
  function legacyMessage() {
    return "Namba hii iko katika mpaka wa awali. Mpaka mpya wa RUCU ni "
      + EXAMPLE + ", ambapo CODII ni nengo la kozi yako. Rekodi yako bado haijasajiliwa "
      + "katika mpaka mpya — wasiliana na ofisi ya RUCUSO ili kuirekebisha, kisha rudi.";
  }

  // ---- CAPTCHA -------------------------------------------------------------

  // Cloudflare Turnstile, loaded on demand and only if a site key is configured.
  //
  // No key ships with the site, because a site key is per-domain and putting
  // someone else's would fail. Without a key this whole path is skipped and the
  // form works exactly as before — see isCaptchaEnabled().
  //
  // If it IS enabled, the token is not trusted here: it is handed to
  // lookup-student, which verifies it against the server-side secret. A token
  // checked only in the browser is a checkbox, not a CAPTCHA.
  var TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var captchaWidget = null;
  var captchaToken = null;

  function siteKey() {
    var cfg = window.RUCUSO_CONFIG || {};
    return cfg.TURNSTILE_SITE_KEY || "";
  }

  function isCaptchaEnabled() {
    return !!siteKey();
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
    if (!isCaptchaEnabled()) return Promise.resolve(null);
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
      // A CAPTCHA that cannot load must not block a real student. Fall through to
      // server-side rate limiting, which is the real control anyway.
      console.warn("CAPTCHA unavailable:", error.message);
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

  // ---- support links --------------------------------------------------------

  // Shown inside error banners. The contacts come from the database when a super
  // admin has set them, so a number that is not filled in is simply left out
  // rather than rendering a dead link.
  function supportHtml() {
    var db = (window.RucusoData && window.RucusoData.DB) || {};
    var contacts = db.contacts || {};
    var items = [];

    if (contacts.phone) {
      var digits = String(contacts.phone).replace(/[^\d+]/g, "");
      items.push(
        '<a href="tel:' + esc(digits) + '">' +
        svg("M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z") +
        esc(contacts.phone) + "</a>"
      );
    }

    if (contacts.email) {
      items.push(
        '<a href="mailto:' + esc(contacts.email) + '">' +
        svg("M2 4h20v16H2z M2 4l10 8 10-8") +
        esc(contacts.email) + "</a>"
      );
    }

    items.push(
      '<button type="button" data-action="open-ai">' + svg("M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z") + "Uliza RUCUSO AI</button>"
    );
    items.push('<button type="button" data-action="go-verify">Njia nyingine ya uthibitisho</button>');

    return (
      '<div class="support" role="group" aria-label="Njia za msaada">' +
      '<span class="support__label">Ushikiliaji</span>' +
      items.join("") +
      "</div>"
    );
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  // ---- the CAPTCHA gate ----------------------------------------------------

  // The button is only enabled when the number is valid AND the CAPTCHA is
  // satisfied. When no site key is configured there is no CAPTCHA to satisfy,
  // so that condition is vacuously true and the regex alone governs — otherwise
  // the button could never enable at all on a deployment that has not set a key
  // up yet. isCaptchaEnabled() is the switch, not a guess.
  function captchaSatisfied() {
    if (!isCaptchaEnabled()) return true;
    return !!captchaToken;
  }

  // ---- the form -------------------------------------------------------------

  var els = {};
  var countdownTimer = null;

  function el(id) { return document.getElementById(id); }

  function cache() {
    els.input = el("ver_reg");
    els.button = el("ver1_btn");
    els.counter = el("ver1_counter");
    els.limit = el("ver1_limit");
    els.hint = el("ver1_hint");
  }

  function setButtonState() {
    if (!els.input || !els.button) return;
    var result = validate(els.input.value);
    var left = attemptsLeft();

    // Three independent reasons the button can be off. Each is explained where
    // it is visible rather than leaving the student to guess at a grey button.
    var captchaOk = captchaSatisfied();
    var ready = result.ok && left > 0 && captchaOk;
    els.button.disabled = !ready;

    // Tells the student *why* it is still grey, which is the thing they cannot
    // work out on their own.
    if (els.hint) {
      if (result.ok && !captchaOk) {
        els.hint.textContent = "Thibitisha kwamba wewe si roboti ili kuendelea.";
        els.hint.className = "fhint fhint--warn";
      } else if (result.ok && left === 0) {
        els.hint.textContent = "Subiri sekunda " + secondsUntilReset() + " kisha jaribu tena.";
        els.hint.className = "fhint fhint--warn";
      } else if (result.ok) {
        els.hint.textContent = "Namba inaonekana sahihi. Endelea.";
        els.hint.className = "fhint fhint--ok";
      } else {
        els.hint.textContent = "";
        els.hint.className = "fhint";
      }
    }

    if (els.counter) {
      var text = els.input.value;
      els.counter.textContent = text ? text.length + " / " + MAX_LEN : "";
      els.counter.className = "fcounter";
      if (text && text.length > MAX_LEN) {
        els.counter.classList.add("fcounter--bad");
        els.counter.textContent = text.length + " / " + MAX_LEN + " — ndefu mno";
      }
    }

    renderLimit();
  }

  function renderLimit() {
    if (!els.limit) return;
    var secs = secondsUntilReset();
    if (!secs) {
      els.limit.innerHTML = "";
      els.limit.hidden = true;
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      setButtonState();
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

    if (!result.ok) {
      var msg = el("ver1_msg");
      if (msg) {
        // The legacy case gets its own wording, and does not suggest retrying:
        // retrying the same number cannot help, the record has to be migrated.
        var canRetry = result.code !== "legacy";
        msg.innerHTML = '<p class="err">' + esc(result.message) + "</p>"
          + (canRetry ? supportHtml() : "");
      }
      els.input.focus();
      return false;
    }

    // Regex alone is not enough to submit once a CAPTCHA is configured — the
    // token has to have been solved. Checked here as well as in
    // setButtonState, so a keyboard Enter or a programmatic call cannot skip it.
    if (!captchaSatisfied()) {
      var capMsg = el("ver1_msg");
      if (capMsg) {
        capMsg.innerHTML = '<p class="err">Thibitisha kwamba wewe si roboti ili kuendelea.</p>';
      }
      return false;
    }

    if (attemptsLeft() === 0) {
      var limitMsg = el("ver1_msg");
      var secs = secondsUntilReset();
      if (limitMsg) {
        limitMsg.innerHTML =
          '<p class="err">Umefanya majaribio mengi. Subiri sekunda <strong>' + secs +
          "</strong> kisha jaribu tena.</p>" + supportHtml();
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

    // Support links are delegated, since the banner is rebuilt on every error.
    document.addEventListener("click", function (event) {
      var target = event.target.closest ? event.target.closest("[data-action]") : null;
      if (!target) return;
      var action = target.dataset.action;
      if (action === "open-ai" && typeof window.openAI === "function") {
        event.preventDefault();
        window.openAI();
      } else if (action === "go-verify" && typeof window.go === "function") {
        event.preventDefault();
        window.go("verify");
      }
    });

    setButtonState();
  }

  // Public surface, so app.js can consume the same validation and the same
  // attempt budget rather than keeping a second copy of the rules.
  window.RucusoVerify = {
    init: init,
    validate: validate,
    guard: guard,
    supportHtml: supportHtml,
    legacyMessage: legacyMessage,
    attemptsLeft: attemptsLeft,
    secondsUntilReset: secondsUntilReset,
    isCaptchaEnabled: isCaptchaEnabled,
    captchaSatisfied: captchaSatisfied,
    ensureCaptcha: ensureCaptcha,
    captchaToken: captchaTokenValue,
    resetCaptcha: resetCaptcha,
    setButtonState: setButtonState,
    NEW_RE: NEW_RE,
    EXAMPLE: EXAMPLE,
    MAX_LEN: MAX_LEN,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    WINDOW_MS: WINDOW_MS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
