// Tests for the leadership hierarchy helpers in js/data.js and the SQL-shaped
// rules in migration 013 (ministry_required, the profiles foreign key, the
// public_leaders view).
//
// These run on node with no dependencies: js/data.js is loaded into a vm with
// the small set of browser globals it touches, and the functions under test are
// pure once the hierarchy has been supplied.
//
//   node tests/hierarchy.test.js

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + "\n         expected: " + e + "\n         actual:   " + a);
  }
}

function checkTrue(name, actual) {
  check(name, !!actual, true);
}

// The rows leadership_hierarchy() returns, in the column names the RPC uses.
const HIERARCHY_ROWS = [
  { tier_key: "executive", tier_label: "Uongozi wa Juu", tier_rank: 1,
    position_key: "president", position_label: "Rais", position_rank: 1, ministry_required: false },
  { tier_key: "executive", tier_label: "Uongozi wa Juu", tier_rank: 1,
    position_key: "prime_minister", position_label: "Waziri Mkuu", position_rank: 2, ministry_required: false },
  { tier_key: "cabinet", tier_label: "Baraza la Mawaziri", tier_rank: 2,
    position_key: "minister", position_label: "Waziri", position_rank: 1, ministry_required: true },
  { tier_key: "cabinet", tier_label: "Baraza la Mawaziri", tier_rank: 2,
    position_key: "deputy_minister", position_label: "Naibu Waziri", position_rank: 2, ministry_required: true },
  { tier_key: "support", tier_label: "Uongozi wa Msaada", tier_rank: 3,
    position_key: "representative", position_label: "Mwakilishi", position_rank: 1, ministry_required: false },
];

// Loads js/data.js with just enough of a browser to run, and RucusoAPI stubbed
// so the hierarchy can be supplied without a database.
function loadData(overrides) {
  const el = () => null;
  const fakeEl = () => ({ appendChild() {}, setAttribute() {}, style: {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Map, Set, Number, String, Boolean, Array, Object, JSON, Math, Date, Error, isNaN,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent, URL, Intl, RegExp,
    location: { href: "/", search: "" },
    navigator: { language: "en" },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { getRandomValues: (a) => a },
  };
  sandbox.window = {
    addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: sandbox.location,
    RucusoAPI: Object.assign({ leadershipHierarchy: async () => HIERARCHY_ROWS }, overrides || {}),
  };
  sandbox.document = {
    addEventListener() {}, getElementById: el, querySelector: el, querySelectorAll: () => [],
    createElement: fakeEl, body: { classList: { add() {}, remove() {} } },
    documentElement: { classList: { add() {}, remove() {} } },
  };
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox.window;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js/data.js"), "utf8"), ctx, { filename: "js/data.js" });
  return { D: sandbox.window.RucusoData, sandbox };
}

console.log("refreshHierarchy / positionsByTier");

(async () => {
  const { D } = loadData();
  await D.refreshHierarchy();

  check("DB.positions normalised to column names",
    D.DB.positions.map((p) => p.key),
    ["president", "prime_minister", "minister", "deputy_minister", "representative"]);

  check("label survives the rename", D.positionLabel("deputy_minister"), "Naibu Waziri");
  check("unknown key returns null", D.positionLabel("nope"), null);

  const byTier = D.positionsByTier();
  check("three tiers, in rank order", byTier.map((t) => t.tier_key), ["executive", "cabinet", "support"]);
  check("cabinet posts ordered by rank",
    byTier[1].positions.map((p) => p.key), ["minister", "deputy_minister"]);

  check("ministry_required is a boolean, not the RPC value",
    D.DB.positions.find((p) => p.key === "minister").ministry_required, true);
  check("ministry_required false for standalone posts",
    D.DB.positions.find((p) => p.key === "president").ministry_required, false);

  console.log("\nvacantSlots");

  // No leaders yet: every standalone post is vacant, and every ministry post is
  // vacant once per active ministry.
  D.DB.leaders = [];
  D.DB.ministries = [
    { id: "m1", name: "Uchelewa", active: true },
    { id: "m2", name: "Elimu", active: true },
    { id: "m3", name: "Imeondolewa", active: false },
  ];

  let v = D.vacantSlots();
  const keys = v.map((x) => x.position + (x.ministry_id ? "@" + x.ministry_id : ""));
  check("standalone posts vacant once each",
    v.filter((x) => !x.ministry_id).map((x) => x.position),
    ["president", "prime_minister", "representative"]);
  check("ministry posts vacant per active ministry (inactive ministry skipped)",
    keys.filter((k) => k.includes("@")).sort(),
    ["deputy_minister@m1", "deputy_minister@m2", "minister@m1", "minister@m2"]);
  check("vacancy carries the label, not just the key",
    v.find((x) => x.position === "minister").position_label, "Waziri");

  // A minister filled for one ministry leaves the other ministries' posts open.
  D.DB.leaders = [{ id: "l1", name: "Amina", position: "minister", ministry_id: "m1", active: true }];
  v = D.vacantSlots();
  check("filling one ministry does not close the post everywhere",
    v.filter((x) => x.position === "minister").map((x) => x.ministry_id), ["m2"]);
  check("that post is no longer listed for the filled ministry",
    v.some((x) => x.position === "minister" && x.ministry_id === "m1"), false);
  check("president still vacant", v.some((x) => x.position === "president"), true);

  // A leader with no ministry_id under a ministry_required post still counts as
  // filling every ministry, which is what the old code did and what the trigger
  // in migration 013 now prevents from happening in the first place.
  D.DB.leaders = [{ id: "l1", name: "Amina", position: "minister", ministry_id: null, active: true }];
  check("ministry-less minister closes the post for all ministries",
    D.vacantSlots().some((x) => x.position === "minister"), false);

  // A standalone post is filled by anyone, no ministry needed.
  D.DB.leaders = [{ id: "l2", name: "Juma", position: "president", ministry_id: null, active: true }];
  check("president no longer vacant once filled",
    D.vacantSlots().some((x) => x.position === "president"), false);

  console.log("\nrefreshHierarchy failure is not fatal");

  const broken = loadData({ leadershipHierarchy: async () => { throw new Error("offline"); } });
  await broken.D.refreshHierarchy();
  check("DB.hierarchy emptied on failure", broken.D.DB.hierarchy, []);
  check("DB.positions emptied on failure", broken.D.DB.positions, []);
  check("vacantSlots returns [] rather than throwing", broken.D.vacantSlots(), []);

  console.log("\nregistrationPattern (case + LIKE escaping)");

  // Loaded from the real _shared/otp.ts source and evaluated, so the escaping
  // rules being tested are the ones the Edge Functions use.
  const shared = fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/otp.ts"), "utf8");
  const body = shared.slice(shared.indexOf("export function registrationPattern"));
  const fnSrc = body.slice(0, body.indexOf("\n}", body.indexOf("export function registrationPattern")) + 2)
    .replace("export function registrationPattern", "function registrationPattern")
    .replace(/: string/g, "")
    .replace(/: any/g, "")
    .replace(/unknown/g, "");
  const pat = vm.runInNewContext("(" + fnSrc + ")", { String, RegExp });

  check("lower case is upper-cased", pat("bfc/23/001"), "BFC/23/001");
  check("mixed case normalised", pat("bFc/23/001"), "BFC/23/001");
  check("surrounding whitespace trimmed", pat("  BFC/23/001  "), "BFC/23/001");
  check("percent is escaped so it cannot match anything", pat("100%"), "100\\%");
  check("underscore is escaped", pat("a_b"), "A\\_B");
  check("backslash is escaped", pat("a\\b"), "A\\\\B");
  check("ordinary registration numbers are untouched", pat("BFC/23/001"), "BFC/23/001");

  console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
  process.exit(failures ? 1 : 0);
})();
