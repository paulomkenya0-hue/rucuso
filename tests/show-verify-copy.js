// One-off audit: what can a student actually READ on the registration step?
//
// Strips comments and tags first, so this measures rendered copy rather than
// source. Not part of run-all.js — kept out of the suite because it prints a
// snapshot with no assertions, and it is most useful when reviewing a copy
// change by eye.
//
// Scoped to #ver-step1 on purpose. The phone and OTP steps further down the
// same view legitimately carry format guidance ("mfano 07XXXXXXXX"), and a
// phone-number example says nothing about the registration number space.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

function visible(segment) {
  return segment
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, " ").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Start at the "<" that opens the step div, not at the id attribute, or the
// leftover attribute text ends up in the extracted copy.
const stepStart = html.lastIndexOf("<", html.indexOf('id="ver-step1"'));
const stepEnd = html.indexOf('id="ver-step2"');
const text = visible(html.slice(stepStart, stepEnd));

console.log("Visible text on the registration step:\n");
console.log("  " + text + "\n");

// Anything here would tell a visitor the shape of a registration number.
const leaks = [
  [/\bRU\s*\//i, "a literal RU/ prefix"],
  [/\b\d\{3,4\}/, "a quantifier from the regex"],
  [/\b(mifumo|regex|pattern)\b/i, "the words format/regex/pattern"],
  [/\b(KODI|MWAKA|NUMIA)\b/, "a placeholder segment name"],
  [/Onyesha/i, "a control that offers to show the format"],
  [/\b\d{2}\s*\/\s*\d{3,4}\b/, "a year/number pattern"],
  [/\/\s*\d{4}\s*\//, "a slash-delimited four-digit year"],
];

let bad = 0;
for (const [re, why] of leaks) {
  const m = re.exec(text);
  if (m) { console.log("  LEAK  " + why + "  ->  " + JSON.stringify(m[0])); bad++; }
}
console.log(bad ? "\n" + bad + " leak(s) found." : "No format leak in the rendered copy.");
