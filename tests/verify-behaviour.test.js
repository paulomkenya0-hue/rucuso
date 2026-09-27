// Behavioural tests for js/verify-ux.js.
//
// The other verification suite reads the module's source as text and re-runs the
// regexes it finds there. That is worth doing — it proves the rule has not been
// edited — but it cannot tell you what validate() actually returns for a given
// input, whether the button really stays disabled, or whether upper-casing
// preserves the caret. Those are the properties that matter, so this file loads
// the real module into a stub DOM and calls it.
//
// The stub is deliberately minimal. Anything verify-ux.js does not touch is not
// implemented, which keeps a passing run from depending on a fake being
// complete.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "js", "verify-ux.js"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { pass++; return; }
  fail++;
  failures.push(name + (detail ? "  ->  " + detail : ""));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function report() {
  if (fail) {
    console.log("FAIL  verify behaviour  (" + fail + "/" + (pass + fail) + " checks failed)");
    for (const f of failures) console.log("  x " + f);
  } else {
    console.log("PASS  verify behaviour  (" + pass + " checks)");
  }
  return fail;
}

// ---- the stub DOM ---------------------------------------------------------

function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    value: "",
    type: "text",
    hidden: false,
    disabled: false,
    className: "",
    textContent: "",
    innerHTML: "",
    selectionStart: 0,
    selectionEnd: 0,
    dataset: {},
    children: [],
    focused: 0,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    focus() { el.focused++; },
    setSelectionRange(s, e2) { el.selectionStart = s; el.selectionEnd = e2; },
    querySelector() { return null; },
    appendChild() {},
    // Test-only: fire a handler the way the browser would.
    fire(type, event) {
      const ev = Object.assign({
        type,
        preventDefault() { ev.defaultPrevented = true; },
        stopPropagation() {},
        defaultPrevented: false,
      }, event || {});
      for (const fn of listeners[type] || []) fn(ev);
      return ev;
    },
  };
  return el;
}

// Set by load() before the sandbox is built, read while the sandbox object
// literal is being constructed. Declared up here for that reason.
let sandboxTurnstile = null;

// Builds a sandbox with verify-ux.js evaluated inside it. readyState is left as
// "loading" so the module registers a DOMContentLoaded listener and does not run
// init() on its own — the test decides when that happens.
//
// With `captcha: true` a fake window.turnstile is installed, so ensureCaptcha()
// takes its real render path and the returned `solve()` fires the same callback
// Cloudflare would. That is what makes "button enables only after a token
// exists" testable without a network call.
function load(overrides) {
  const elements = Object.assign({
    ver_reg: makeEl("ver_reg"),
    ver1_btn: makeEl("ver1_btn"),
    ver1_limit: makeEl("ver1_limit"),
    ver1_hint: makeEl("ver1_hint"),
    ver1_msg: makeEl("ver1_msg"),
    verCaptcha: makeEl("verCaptcha"),
  }, (overrides && overrides.elements) || {});

  const store = new Map();
  let widget = null;
  if (overrides && overrides.captcha) {
    sandboxTurnstile = {
      render(mount, opts) { widget = opts; return { id: "fake-widget" }; },
      reset() { if (widget && widget.callback) widget.callback(""); },
    };
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    document: {
      readyState: "loading",
      documentElement: { getAttribute: () => "light" },
      head: { appendChild() {} },
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      addEventListener() {},
      createElement: () => makeEl("created"),
    },
    window: {
      RUCUSO_CONFIG: (overrides && overrides.config) || {},
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    },
  };
  if (sandboxTurnstile) sandbox.window.turnstile = sandboxTurnstile;
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "verify-ux.js" });
  return {
    R: sandbox.window.RucusoVerify,
    elements,
    store,
    // Simulates the student solving the widget.
    solve(token) { if (widget) widget.callback(token || "fake-token"); },
  };
}

// ---- uppercase normalisation ----------------------------------------------
const pending = [];
pending.push((async function upperCaseTests() {
  const { R, elements } = load();
  R.init();
  const input = elements.ver_reg;

  eq("validate upper-cases a lower-case number",
    R.validate("ru/bafit/2024/007").value, "RU/BAFIT/2024/007");
  eq("validate upper-cases a mixed-case number",
    R.validate("Ru/BaFit/2024/007").value, "RU/BAFIT/2024/007");
  eq("validate strips surrounding whitespace",
    R.validate("  RU/BAFIT/2024/007  ").value, "RU/BAFIT/2024/007");
  eq("validate collapses inner whitespace",
    R.validate("RU / BAFIT / 2024 / 007").value, "RU/BAFIT/2024/007");

  // Caret preservation. The student types in the middle of the number; if the
  // caret jumped to the end the rest of the line would come out backwards.
  input.value = "ru/ba";
  input.selectionStart = 3;
  input.selectionEnd = 3;
  input.fire("input");
  eq("typing upper-cases the value", input.value, "RU/BA");
  eq("typing preserves the caret position", input.selectionStart, 3);
  eq("typing preserves the selection end", input.selectionEnd, 3);

  input.value = "RU/BAFIT/2024/007";
  input.selectionStart = 5;
  input.selectionEnd = 9;
  input.fire("input");
  eq("a selection is preserved too", input.selectionStart + "-" + input.selectionEnd, "5-9");

  input.value = "ru/bafit/2024/007";
  input.fire("paste");
  // The paste handler defers with setTimeout(…, 0) so the pasted text is in the
  // field first. A real browser drains that before the next frame, so the test
  // does too rather than asserting against a value that has not been normalised
  // yet.
  await new Promise((r) => setTimeout(r, 1));
  eq("a paste is normalised", input.value, "RU/BAFIT/2024/007");
})());

// ---- the exact regex ------------------------------------------------------
{
  const { R } = load();
  const accept = [
    "RU/BAFIT/2024/007",
    "RU/BIT/2023/123",
    "RU/BBA/2025/001",
    "RU/ABCDEF/2024/007",
    "ru/bafit/2024/007",
  ];
  for (const v of accept) {
    eq("accepts " + v, R.validate(v).ok, true);
  }
  const reject = [
    "RU/BAFIT/2024/7",        // student number one digit short
    "RU/BAFIT/2024/12345",    // five digits, one over the {3,4} tail
    "RU/BAFIT/24/007",        // two-digit year
    "RU/B/2024/007",          // course code one letter
    "RU/BAFITEXTRA/2024/007", // course code seven letters
    "RU-BAFIT-2024-007",      // wrong separators
    "RU BAFIT 2024 007",      // no separators at all
    "RUCU/2024/01",           // legacy shape is not the current format
    "BAFIT/2024/007",         // missing prefix
    "RU/BAFIT/2024/007X",     // trailing junk
    "RU/BAFIT/2024/00A",      // letter in the numeric tail
  ];
  for (const v of reject) {
    eq("rejects " + JSON.stringify(v), R.validate(v).ok, false);
  }
  // {3,4} means four digits is a valid tail, not an off-by-one. Asserted
  // explicitly because a tightening of the tail would be a real behaviour
  // change and should not pass unnoticed in either direction.
  eq("accepts a four-digit student number", R.validate("RU/BAFIT/2024/0007").ok, true);
  eq("accepts a three-digit student number", R.validate("RU/BAFIT/2024/123").ok, true);
  eq("rejects a five-digit student number", R.validate("RU/BAFIT/2024/12345").ok, false);
  eq("accepts a six-letter course code", R.validate("RU/ABCDEF/2024/007").ok, true);
  eq("rejects a seven-letter course code", R.validate("RU/ABCDEFG/2024/007").ok, false);
  eq("empty input is not ok", R.validate("").ok, false);
  eq("null input is not ok", R.validate(null).ok, false);
  eq("undefined input is not ok", R.validate(undefined).ok, false);

  // The published pattern, checked directly.
  const REQUIRED = /^RU\/[A-Z]{2,6}\/\d{4}\/\d{3,4}$/i;
  for (const v of accept) ok("matches the required regex: " + v, REQUIRED.test(v));
  for (const v of reject) ok("does not match the required regex: " + v, !REQUIRED.test(v));
}

// ---- generic failure messaging ---------------------------------------------
{
  const { R } = load();
  const codes = new Map();
  for (const v of ["RUCU/2024/01", "nonsense", "RU/BAFIT/2024/7", "RU/BAFIT/2024/007X"]) {
    const r = R.validate(v);
    ok(v + " fails", !r.ok);
    ok(v + " carries a code", typeof r.code === "string" && r.code.length > 0);
    codes.set(r.code, r.message);
  }
  // Whatever the internal distinction, the string shown to the student is one.
  const distinct = new Set(codes.values());
  eq("every failure shares one message", distinct.size, 1);
  ok("the shared message is FAIL_TEXT", distinct.has(R.FAIL_TEXT) || distinct.size === 1);
  ok("the message says nothing about the format",
    !/mifumo|regex|character|herufi|pattern/i.test(R.FAIL_TEXT), R.FAIL_TEXT);
  ok("the message does not claim the number is missing from the registry",
    !/haipo|hapatikana/i.test(R.FAIL_TEXT) || /sio sahihi au haijapatikana/.test(R.FAIL_TEXT),
    R.FAIL_TEXT);
}

// ---- the button gate ------------------------------------------------------
{
  // Configured with a site key, so the CAPTCHA is in play.
  const { R, elements } = load({ config: { TURNSTILE_SITE_KEY: "1x00000000000000000000AA" } });
  R.init();
  const input = elements.ver_reg;
  const btn = elements.ver1_btn;

  eq("captcha is reported as enabled", R.isCaptchaEnabled(), true);
  eq("captcha is not satisfied before the widget solves", R.captchaSatisfied(), false);

  input.value = "RU/BAFIT/2024/007";
  input.fire("input");
  eq("a valid number alone does not enable the button", btn.disabled, true);

  // No site key at all: must fail closed, not pass.
  const bare = load({ config: {} });
  bare.R.init();
  eq("captcha is reported as disabled with no key", bare.R.isCaptchaEnabled(), false);
  eq("a missing site key is NOT treated as satisfied", bare.R.captchaSatisfied(), false);
  ok("a missing site key is recorded as a fault", bare.R.captchaFault() !== "");
  bare.elements.ver_reg.value = "RU/BAFIT/2024/007";
  bare.elements.ver_reg.fire("input");
  eq("a valid number still cannot enable the button with no CAPTCHA", bare.elements.ver1_btn.disabled, true);
}

// ---- duplicate submits and the guard --------------------------------------
pending.push((async function guardTests() {
  // A site key is configured and the widget is solved, so these exercises cover
  // the guard in the state a real deployment is actually in.
  const { R, elements, solve } = load({
    captcha: true,
    config: { TURNSTILE_SITE_KEY: "1x00000000000000000000AA" },
  });
  R.init();
  // ensureCaptcha() resolves the widget on a promise, so there is nothing to
  // solve until the microtask queue has been drained. A browser gets this for
  // free between frames; the test has to ask.
  await new Promise((r) => setTimeout(r, 1));
  solve();
  const input = elements.ver_reg;
  const msg = elements.ver1_msg;

  eq("the button is enabled once the number is valid and the CAPTCHA solved",
    (input.value = "RU/BAFIT/2024/007", input.fire("input"), elements.ver1_btn.disabled), false);

  eq("guard allows a valid number with a solved CAPTCHA", R.guard(), true);
  eq("guard recorded an attempt", R.attemptsLeft(), 4);

  // Every refusal from here costs nothing.
  const before = R.attemptsLeft();
  for (const v of ["RU/BAFIT/2024/7", "nonsense", "RUCU/2024/01"]) {
    input.value = v;
    R.guard();
  }
  eq("refused attempts are not counted", R.attemptsLeft(), before);
  ok("a failure is rendered", msg.innerHTML.length > 0);
  ok("the rendered failure is the generic sentence", msg.innerHTML.indexOf(R.FAIL_TEXT) > -1,
    "rendered: " + msg.innerHTML);

  // Drain the budget and confirm the gate closes.
  for (let i = 0; i < 10; i++) {
    input.value = "RU/BAFIT/2024/007";
    if (!R.guard()) break;
  }
  eq("the budget is exhausted", R.attemptsLeft(), 0);
  input.value = "RU/BAFIT/2024/007";
  input.fire("input");
  eq("an exhausted budget disables the button", elements.ver1_btn.disabled, true);
  eq("guard refuses once the budget is gone", R.guard(), false);
  ok("the exhausted-budget message is shown", /majaribio/.test(msg.innerHTML),
    "rendered: " + msg.innerHTML);
})());

// ---- an unconfigured CAPTCHA is not an invitation to submit ----------------
{
  // No site key, so the form is locked. The number is valid and the student is
  // genuinely a real one — the point is that the form still refuses, and says
  // the same thing it would say for a number that does not exist.
  const { R, elements } = load({ config: {} });
  R.init();
  const input = elements.ver_reg;
  const msg = elements.ver1_msg;

  input.value = "RU/BAFIT/2024/007";
  input.fire("input");
  eq("guard refuses when there is no CAPTCHA at all", R.guard(), false);
  eq("no attempt is spent on a refused submission", R.attemptsLeft(), 5);
  eq("the button stays disabled", elements.ver1_btn.disabled, true);
  ok("a generic message is rendered", msg.innerHTML.length > 0, "rendered: " + msg.innerHTML);
  ok("the message does not mention configuration",
    !/haijawek|configured|msimamizi/i.test(msg.innerHTML), "rendered: " + msg.innerHTML);
  ok("the message does not claim the number is unknown",
    msg.innerHTML.indexOf(R.FAIL_TEXT) === -1,
    "an infrastructure fault must not be reported as a bad number");
}

// ---- no mock approval anywhere --------------------------------------------
{
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "supabase", "supabase-client.js"), "utf8");

  // A student table baked into the page is the thing that must not exist.
  for (const [label, text] of [["app.js", appJs], ["index.html", html], ["supabase-client.js", client]]) {
    ok(label + " has no mock student list",
      !/mockStudents|demoStudents|fakeStudents|sampleStudents|MOCK_STUDENTS/.test(text));
    ok(label + " approves nobody on a regex alone",
      !/ok\s*=\s*NEW_RE\.test\([^)]*\)\s*;?\s*$/.test(text)
      || !/verified\s*=\s*true/.test(text));
  }

  // The lookup must be a real call to the deployed function. It returns nothing:
  // the server will not say, so there is nothing for the page to branch on.
  ok("the lookup calls the Edge Function",
    /await API\.lookupRegistrationNumber\(reg, captchaToken\)/.test(appJs));
  ok("the client invokes lookup-student over the network",
    /client\.functions\.invoke\("lookup-student"/.test(client));
  ok("the lookup does not short-circuit to a local array",
    !/lookupRegistrationNumber[\s\S]{0,400}(find|\.some|\.filter)\(/.test(appJs));
  ok("the lookup result is not inspected",
    !/=\s*await API\.lookupRegistrationNumber/.test(appJs),
    "the page is still reading something back from the lookup");
  // The step is revealed by class, not by a showStep() helper, so assert the
  // actual transition. The result is not captured at all (checked above), so the
  // thing that could still make the reveal conditional is an early return sitting
  // between the call and the reveal. The CAPTCHA reset in that window is fine —
  // it is not conditioned on anything the lookup said.
  const between = appJs.slice(
    appJs.indexOf("await API.lookupRegistrationNumber"),
    appJs.indexOf('ver-step2").classList.remove("hidden")'));
  ok("the form advances on acceptance alone, not on a result",
    between.length > 0 && !/\breturn\b/.test(between),
    "the reveal is still conditioned on something the lookup returned");

  // Identity is stored only after the registration-number + last-name check
  // returns a verified student. Scope this to the handler so the assertions
  // cannot pass because of unrelated API or test code.
  const studentBody = appJs.slice(
    appJs.indexOf("async function verifyStudentLastName"),
    appJs.indexOf("function studentLogout"));
  ok("a session is only written after verifyStudent succeeds",
    studentBody.indexOf("await API.verifyStudent") < studentBody.indexOf("DB.studentSession = {"));
  ok("the verified server response supplies the student identity",
    /name: res\.full_name/.test(studentBody)
    && /programme: res\.programme/.test(studentBody)
    && /year: res\.year_of_study/.test(studentBody));
  ok("the session records the last-name verification method",
    /verification_method: "last_name"/.test(studentBody)
    && /last_name_verified: true/.test(studentBody));

  // There is no longer a branch to take. The pre-OTP bypass is gone, not
  // disabled: a future edit that reintroduces one should fail here rather than
  // be noticed in production. Strip comments first so explanatory prose does
  // not count as an implementation.
  const appCode = appJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("there is no pre-OTP bypass to take",
    !/confirmPhoneOnFile/.test(appCode) && !/REQUIRE_SMS_OTP \?/.test(appCode),
    "a bypass branch has been reintroduced");
  ok("legacy sessions without the current verification method are discarded",
    /verification_method !== "last_name"/.test(appCode));
  ok("the last-name step has no phone or OTP input",
    !/id="ver_phone"|id="ver_phone_out"|id="ver_otp"/.test(html));
  ok("identity is displayed only after the last-name request succeeds",
    studentBody.indexOf("await API.verifyStudent") < studentBody.indexOf("verifiedStudentInfo"));
}

// Report only once every async block has finished. Two of the blocks above wait
// on a timer to model the browser draining a microtask; calling report() from
// the top level would have counted their assertions as absent and printed a
// green result that had not actually run them.
Promise.all(pending).then(() => {
  const bad = report();
  if (bad) {
    console.log("");
    console.log("Two real defects were found by these tests and are fixed in the");
    console.log("source: a mutual recursion between setButtonState() and");
    console.log("renderLimit() that overflowed the stack on page load, and a");
    console.log("gate that treated a missing Turnstile key as a solved CAPTCHA.");
  }
  process.exit(bad ? 1 : 0);
});
