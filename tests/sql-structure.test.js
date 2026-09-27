// Structural sanity checks for the SQL migrations.
//
// This is not a SQL parser and it does not claim to be. It catches the mistakes
// that are expensive to find after a migration has half-applied: an unterminated
// string or dollar-quoted block, unbalanced parentheses, a DO block that is never
// closed, and identifiers quoted with the wrong case (Postgres folds unquoted
// identifiers to lower case, so "LeadershipTiers" and leadership_tiers are two
// different objects and the second one is the one that does not exist).
//
//   node tests/sql-structure.test.js

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MIG = path.join(ROOT, "supabase/migrations");

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + "\n         expected: " + e + "\n         actual:   " + a);
  }
}

// Walks the file once, tracking whether we are inside a line comment, a string
// literal, a dollar-quoted block or an identifier, so that punctuation inside
// any of those is not counted as structure.
function scan(sql) {
  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null;          // "'" or '"'
  let dollarTag = null;      // e.g. "$$" or "$func$"
  const unterminated = [];

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (dollarTag) {
      if (c === "$" && sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (c === quote) {
        // '' inside a literal is an escaped quote, not the end.
        if (next === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "-" && next === "-") { inLineComment = true; i++; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) { dollarTag = m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }

  if (quote) unterminated.push("string literal (" + quote + ") never closed");
  if (dollarTag) unterminated.push("dollar-quoted block (" + dollarTag + ") never closed");
  if (inBlockComment) unterminated.push("block comment never closed");
  if (depth !== 0) unterminated.push("parentheses off by " + depth);

  return unterminated;
}

const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();

console.log("supabase/migrations (" + files.length + " files)");

for (const f of files) {
  const sql = fs.readFileSync(path.join(MIG, f), "utf8");
  const problems = scan(sql);
  check(f + " is structurally complete", problems, []);
}

// Postgres folds unquoted identifiers to lower case, so a quoted or
// mixed-case object name is nearly always a mistake in this codebase.
console.log("\nidentifier case");
for (const f of files) {
  const sql = fs.readFileSync(path.join(MIG, f), "utf8");
  const mixed = [];
  // Only real statements count, so comments and string literals are stripped
  // first. Otherwise prose like "CREATE OR REPLACE VIEW refuses to..." is
  // reported as if it were a statement.
  const code = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");

  const re = /\b(create|alter|drop)\s+(or\s+replace\s+)?(function|view|table|index|trigger|policy|type)\s+(if\s+(not\s+)?exists\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(code))) {
    if (/[A-Z]/.test(m[6]) || /[A-Z]/.test(m[3])) mixed.push(m[3] + " " + m[6]);
  }
  if (mixed.length) {
    failures++;
    checks++;
    console.log("  FAIL " + f + " uses mixed-case identifiers: " + mixed.join(", "));
  }
}
checks++;
console.log("  ok   no migration declares an object with a mixed-case name");

// The two migrations that the current work depends on must be present and in
// order, since 013 references the tables it creates and 012 revokes RPCs from
// an earlier migration.
console.log("\nordering");
const names = files.map((f) => parseInt(f.slice(0, 3), 10));
check("migration numbers are unique", new Set(names).size, names.length);
check("migrations are in ascending order",
  names.every((n, i) => i === 0 || n > names[i - 1]), true);

for (const required of ["012_student_lookup_rate_limit.sql", "013_leadership_hierarchy.sql"]) {
  check(required + " exists", fs.existsSync(path.join(MIG, required)), true);
}

console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
process.exit(failures ? 1 : 0);
