# RUCUSO
**Ruaha Catholic University Students' Organization — Digital Platform**

Academic Year 2026/2027 · Production: **https://rucuso.online**

## What this is

RUCUSO is a static site (vanilla HTML/CSS/JS — no build step, no framework, no package manager)
that runs the university's student-organisation platform: a public leadership directory and
services directory, a feedback/complaints/challenges intake with reference tracking, SMS-OTP
student verification, a Kiswahili AI assistant, and staff portals for administrators and leaders.

All shared data lives in **Supabase Postgres**, not in the browser, so a change made on one
device is visible on every other device immediately.

## Routes

### Public — `index.html` (one page, in-app views)
| View | Purpose |
| --- | --- |
| `home` | Home / directory preview |
| `submit` | Submit feedback, complaint, challenge, suggestion or praise |
| `verify` | Student verification: registration number → phone → SMS OTP |
| `track` | Track a submission by its reference number |
| `reports`, `dashboard`, `issues`, `settings` | **Legacy.** Marked `data-legacy="1"` and no longer in the navigation; staff are sent to `/admin/*` instead. Do not build new features here. |

### Admin — `/admin/*` (roles below; all read through the shared guard)
| Path | Purpose | Allowed roles |
| --- | --- | --- |
| `/admin/login/` | Sign in | public |
| `/admin/dashboard/` | Totals and breakdowns | super_admin, admin |
| `/admin/feedback/` | Manage feedback/maoni | super_admin, admin |
| `/admin/announcements/` | Publish and expire announcements | super_admin, admin |
| `/admin/documents/` | Upload and manage documents | super_admin, admin |
| `/admin/students/` | Student records | super_admin, admin |
| `/admin/ministries/` | Ministries (Wizara) | super_admin, admin |
| `/admin/categories/` | Feedback categories | super_admin, admin |
| `/admin/services/` | Student services | super_admin, admin |
| `/admin/reports/` | Date-ranged report summary + CSV export | super_admin, admin |
| `/admin/audit-logs/` | Filterable audit log | super_admin, admin |
| `/admin/leaders/` | Leader account CRUD (via Edge Function) | super_admin |
| `/admin/ai/` | RUCUSO AI console | super_admin |
| `/admin/admins/` | Read-only staff roster | super_admin |
| `/admin/settings/` | System settings | super_admin |

### Leader
| Path | Purpose |
| --- | --- |
| `/leader/login/` | Leader sign-in |
| `/leader/dashboard/` | Leader dashboard (position + ministry scoped) |
| `/change-password/` | Forced password change on first login |

An `admin` additionally sees only the sidebar entries its `profiles.permissions` map grants.

## Repository layout
| Path | Purpose |
| --- | --- |
| `index.html` | All public markup and in-app view structure |
| `css/portal.css` | The single shared stylesheet for public, admin and leader pages |
| `css/motion.css` | Animations, tilt, map frame, verification helpers. Every effect collapses under `prefers-reduced-motion` |
| `js/app.js` | Public screen logic and every call into the data layer |
| `js/data.js` | The app's data layer: Supabase loaders/mutators + in-memory cache |
| `js/auth-guard.js` | `window.RucusoGuard.requireRole()` — the shared route guard |
| `js/verify-ux.js` | `window.RucusoVerify` — registration-number rules, attempt budget, CAPTCHA mount |
| `js/tilt.js` | `window.RucusoTilt` — pointer-tracking 3D tilt; no-ops on touch and under reduced motion |
| `js/map.js` | `window.RucusoMap` — lazy-loaded Leaflet map of the RUCU campus |
| `supabase/config.js` | Public Supabase URL + anon key (safe to publish; RLS is the boundary) |
| `supabase/supabase-client.js` | `window.RucusoAPI` — the only file that talks to Supabase |
| `supabase/schema.sql` | Migration 001 — tables, RLS policies, first RPCs |
| `supabase/migrations/002_production_backend.sql` | Storage buckets, seeded reference data, closed RLS gaps, `submit_feedback()` |
| `supabase/migrations/003_ai_assistant.sql` | `ai_queries` — the AI rate-limit ledger (no browser policies) |
| `supabase/migrations/004_roles_permissions.sql` | Role/title split, `profiles.permissions`, per-permission RLS |
| `supabase/migrations/005_leader_visibility_and_password_flow.sql` | `leaders.public_visible`, `must_change_password` |
| `supabase/migrations/006_student_phone_verification.sql` | `verify_student_identity()` RPC |
| `supabase/migrations/013_leadership_hierarchy.sql` | Tiers, positions, assignment trigger, executive access scope |
| `supabase/functions/send-otp`, `verify-otp`, `rucuso-ai`, `leader-admin` | Edge Functions |
| `supabase/functions/lookup-student` | Pre-OTP gate. Rate limited per number and per client, Turnstile verified server-side, returns `{ok:true}` and nothing else — see "The existence oracle" |
| `robots.txt`, `sitemap.xml`, `CNAME` | SEO / custom domain |

### The enhancement layer is optional by construction

`css/motion.css`, `js/tilt.js`, `js/map.js` and `js/verify-ux.js` are the only new
files, and none of them is required for the site to function. Delete all four and
every screen still works — the page just stops moving. That is deliberate: the
previous work here was all about a verification flow that must not break, so the
animation work is built so it cannot take the flow down with it.

Two things about them are load-bearing rather than cosmetic:

- **No bundler, no modules.** The site is plain `<script>` tags and `window.*`
  globals. These files match that (IIFE + global) rather than using `export`,
  which would fail to resolve at runtime.
- **`js/verify-ux.js` owns the registration-number rule and `js/app.js` defers
  to it.** Two copies of a validation rule will drift, and the copy that drifts
  is the one that quietly starts rejecting registered students.
  `tests/verify-rules.test.js` fails if that ever happens.

### Registration number format

The current official RUCU format is:

```
RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>      RU/BAFIT/2024/007
```

enforced in three places, on purpose:

- `js/verify-ux.js` — `NEW_RE`, so the student gets immediate feedback and the
  "Endelea" button stays disabled until the number matches
- `lookup-student` — the same pattern again, server-side, and anything matching
  neither the current nor the legacy shape is rejected *before* it can consume a
  rate-limit budget
- `students_current_format_chk` in migration 014 — a `CHECK` constraint, so the
  format is a database rule. A CSV import, a spreadsheet paste or a direct
  `psql` session cannot introduce a malformed "current" number. The front-end
  regex is a convenience, not the only defence.

**This is a breaking change and it is not done by deploying the code.** The
course code is the segment that does not exist in the old number, and it is not
stored anywhere: `programme` and `faculty` are free text and neither contains a
course code, so it cannot be derived. Migration 014 adds `course_code`,
`legacy_registration_number` and `registration_format`, and leaves the rewrite
to a function you run on purpose:

```bash
# 1. see how much work there is
select * from registration_migration_report();

# 2. the worklist: which students still need a course code, grouped by programme
select * from registration_course_code_worklist();

-- 3. supply the course codes, e.g.
update students set course_code = 'BAFIT' where programme = 'Bachelor of Accounting and Finance';

-- 4. rewrite the numbers. Skips anything still missing a course code.
select backfill_student_registration_numbers();

-- 5. confirm
select * from registration_migration_report();   -- still_pending should be 0
```

The backfill never invents a course code. Defaulting a missing one would mint
numbers that pass the `CHECK` constraint and look completely valid while sending
a student to the wrong course's page, so it skips those rows and leaves them
visibly pending instead.

### Migrating the existing registry

`lookup-student` still searches `legacy_registration_number`, because a student
who has not been backfilled yet should not be told their number is wrong. It does
not *say* so, though — see below.

`MIGRATION_LEGACY_LOOKUP` has been removed. There is no longer a switch to turn
off, because there is no longer a response to turn off: the legacy case is now
logged server-side and returned to the browser as the same `{ "ok": true }` that
every other accepted number gets. The `legacy_registration_number` search stays
until the backfill is finished, and can be dropped from `_shared/otp.ts` in the
release that finishes it.

### The existence oracle

This form is the only unauthenticated entry point into the student registry, so
"which registration numbers exist" is worth protecting on its own. A registration
number is a short, partly sequential, human-chosen string; an attacker can
enumerate the plausible space quickly and, without care, learn who is enrolled
and which cohort they are in.

**The rule: nothing before the SMS code has been proved says anything about
whether a number exists.** Not the status code, not the body, not the timing, and
certainly not who receives a text message.

| Stage | Known number | Unknown number |
| --- | --- | --- |
| `lookup-student` | `200 {"ok":true}` | `200 {"ok":true}` |
| `send-otp` | `200 {"ok":true,"expires_in":300}` | `200 {"ok":true,"expires_in":300}` |
| `verify-otp`, wrong code | `400 {"verified":false,"error":"INVALID_CODE"}` | `400 {"verified":false,"error":"INVALID_CODE"}` |
| `verify-otp`, correct code | `200` + identity | unreachable — no code was ever sent |

Four things make that hold.

1. **The client never receives an existence value.** `lookup-student` returns
   `{ "ok": true }` and nothing else. The form advances to step 2 on acceptance
   alone, and `lookupRegistrationNumber()` resolves to `undefined` so there is
   nothing to branch on. Reaching step 2 is not the answer any more.

2. **The destination phone is server-side.** An earlier version had the student
   type their phone number into step 2, and `send-otp` posted it. Uniform HTTP
   responses would not have helped: an attacker who owns a phone can watch which
   numbers produce a text message arriving at *their own* handset, and that is an
   oracle no amount of response-shaping touches. `send-otp` now takes only the
   registration number, resolves the student itself, and texts the number on
   file. An unknown number sends nothing at all.

3. **Identity arrives with the proof.** `verify-otp` is the first and only place
   a name, programme, year, faculty or phone number is returned, and it returns
   them only after the code matches. The browser holds no phone number at any
   point before that, so a request field cannot be repointed at another student.

4. **Failures are not just equal in body, they are equal in cause.** No pending
   code, expired code, exhausted attempts, wrong code, deleted row, unknown
   number and malformed number all resolve to the same
   `INVALID_CODE`. An earlier version returned a distinct `NOT_FOUND` for a
   number with no pending row, which was reachable *only* for numbers that exist
   — the oracle, in a different coat.

`verify-otp` also hashes a dummy value against a dummy phone number when there is
no row to check, so a rejection costs the same work whether or not a code was
ever issued. `lookup-student` runs its registry query for known and unknown
numbers alike and returns the result to the log, not the response.

**What this costs.** A student whose record has no usable phone on file, or whose
SMS provider is down, is told the same thing as somebody whose number is not in
the registry. Both outcomes are logged server-side with the reason, so the
operator can see them, and neither is visible to the student. That is a
deliberate trade of support convenience for a closed oracle, and it is the
reason the operator log matters more than it used to.

### CAPTCHA

**A missing CAPTCHA locks the form. This is deliberate, and it is the one
setting that can stop a student verifying at all.**

`supabase/config.js` ships with `TURNSTILE_SITE_KEY: ""`. In that state the
verification form does *not* fall back to working without a CAPTCHA: the button
stays disabled and the hint reads "Uthibitisho wa usalama haupatikani kwa sasa."
The same happens if Cloudflare is unreachable at page load.

The blank key is safe because the browser can see it. A blank
`TURNSTILE_SECRET_KEY` on the function is *not* the same situation and used to be
treated as though it were: the earlier code skipped verification entirely when
the secret was absent, which fails open in the one deployment that matters — a
site key set in `config.js` with the server secret forgotten. The widget renders,
the student solves it honestly, the token arrives, and the server discards it
without checking. The CAPTCHA is decorative and any script can skip it.

So the server now requires the secret, and refuses the request with
`503 NOT_CONFIGURED` when it is missing. Local work without a CAPTCHA is an
explicit, loudly named opt-in that logs a warning on every request:

```bash
# LOCAL DEVELOPMENT ONLY. Never set this on a deployed function.
supabase secrets set LOCAL_DEV_SKIP_CAPTCHA=1
```

The previous behaviour was the opposite. A missing site key made
`captchaSatisfied()` return `true`, on the reasoning that the button would
otherwise never enable on a fresh deployment. The problem is that a deployment
which *forgot* to configure Turnstile then ran with no bot protection while the
button looked identical to one where a CAPTCHA had been solved — no visible
difference, no console warning, no way for anyone to notice. For a system whose
entire job is deciding who may claim a student identity, "usable but unguarded"
is the worse failure, so the gate now fails closed and the reason goes to the
console.

**Set the site key before telling students the form is live.** The order matters:

1. Create a Turnstile widget for `rucuso.online` in the Cloudflare dashboard.
2. Set the secret on the server — this is the one that must never be in a file:

   ```bash
   supabase secrets set TURNSTILE_SECRET_KEY=<secret>
   supabase functions deploy lookup-student
   ```

3. Put the **site** key in `supabase/config.js`. Site keys are meant to be
   public.

`lookup-student` then requires a token and verifies it against Cloudflare's
`siteverify` endpoint **on the server**, before spending any rate-limit budget.
A token checked in the browser is a checkbox, not a CAPTCHA. Note the ordering
in the steps above: deploying the secret before publishing the site key means
there is no window in which the page shows a widget the server will not accept.

If the site key is blank and you need the form usable immediately, that is a
deliberate downgrade and it should be a temporary one — server-side rate limits
(20 per registration number, 60 per client per 10 minutes) still apply, but they
are a ceiling rather than a filter.

## What still lives in the browser

Exactly two `localStorage` keys, neither of them shared application data:

- `rucu_student_session_v1` — the student's own verified session, so a refresh does not force
  them to re-enter an SMS code.
- `rucu_ui_v1` — UI preferences (theme).

Everything else is read from and written to Supabase on every load. **There is no
localStorage fallback**: if Supabase is unreachable the app says so rather than pretending the
operation succeeded.

## Security model

- Supabase Auth is the only authentication. No passwords are stored in the browser and no demo
  accounts exist.
- Every admin/leader account needs a row in `profiles`. Without one, login succeeds but the app
  shows "Akaunti hii haina profili ya msimamizi" and nothing else is possible.
- **Row Level Security is the real boundary.** `js/auth-guard.js` only stops an unauthorised
  visitor from seeing admin markup — every query still runs as that visitor's own role and
  Postgres decides what comes back. Migration 004 splits this per permission
  (`profiles.permissions`), and `super_admin` passes every check implicitly.
- The public cannot read the `students` or `feedback` tables. Student verification goes through
  the `lookup-student`, `send-otp` and `verify-otp` Edge Functions, which return the same
  response for every registration number until the SMS code is proved; the student's name,
  programme, year and phone are returned by `verify-otp` and only after that. All three are
  rate-limited per number and per client IP, and Turnstile is verified server-side.
  `lookup_student()` itself is `service_role` only as of migration 012. Tracking goes through
  `track_feedback()`.
- Public submissions go through `submit_feedback()`, which mints the reference number, enforces
  anonymity server-side, and blocks duplicate spam inside the database.
- The public leadership directory reads a dedicated `public_leaders` view, so registration
  numbers and private phone numbers are never exposed to visitors.
- Feedback attachments live in a **private** storage bucket; staff open them through a
  short-lived signed URL.
- The `service_role` key exists only inside the Edge Functions, as a Supabase secret.
- The **AI provider's key is server-side only** (`AI_API_KEY`). No browser file contains an AI
  key. `rucuso-ai` looks the caller's real role up server-side and assembles only the data that
  caller may see — visitors get public content, staff additionally get aggregate report
  numbers. No individual report, attachment, student name, registration number, phone number or
  private leader field is ever sent to the model.

## Setup

1. Run `supabase/schema.sql` (001) in the Supabase SQL Editor — once, on a new project.
2. Run `supabase/migrations/002_production_backend.sql`, then `003_ai_assistant.sql`, then
   `004_roles_permissions.sql`, then `005_leader_visibility_and_password_flow.sql`. Each one says
   in its header what order it expects. **002 is required for the live site.**
3. Create the first real admin:
   - Dashboard → Authentication → Users → **Add user** (real email + password), then:
     ```sql
     insert into profiles (id, full_name, role)
     values ('<paste-the-uid>', 'Jina Lamili', 'super_admin')
     on conflict (id) do update set role = excluded.role;
     ```
4. `supabase/config.js` must hold the project URL and anon key. It is committed on purpose: the
   anon key is public by design and is only safe because RLS is on every table. Never put a
   `service_role` or AI key in it. There is no second copy of this file — every page loads this
   one path.
5. SMS OTP. A real SMS code is mandatory — the browser holds no phone number at any point, so
   `send-otp` resolves the student itself and texts the number on file. Set the provider's
   credentials as Supabase secrets and deploy the three functions before letting students in, or
   every attempt will be refused with an error the form cannot recover from:
   ```bash
   supabase secrets set SMS_PROVIDER=beem            # or africastalking
   supabase secrets set SMS_API_KEY=your_key
   supabase secrets set SMS_API_SECRET=your_secret   # Beem only
   supabase secrets set SMS_SENDER_ID=RUCUSO
   supabase secrets set OTP_PEPPER=<openssl rand -base64 48>
   supabase secrets set STUDENT_LOOKUP_RATE_LIMIT_SECRET=<openssl rand -base64 32>
   supabase functions deploy send-otp
   supabase functions deploy verify-otp
   supabase functions deploy lookup-student
   ```
   `STUDENT_LOOKUP_RATE_LIMIT_SECRET` and `OTP_PEPPER` are not optional. All three functions
   return `503 NOT_CONFIGURED` without them, which is the same response a caller gets if the
   registry is unreachable, so a missing secret is a deployment fault to fix in the function log
   rather than something a student can be told about.

   Deploying these three is also what closes the oracle. The form's behaviour cannot be verified
   from the browser alone: if `send-otp` is still on a revision that accepts a `phone` field, a
   student can be texted at a number of their choosing. Check the deployed revision before
   opening the form to anyone.
6. Turnstile, required for the same reason and configured the same way — see "CAPTCHA" above.
   Set both halves, or the form locks:
   ```bash
   # supabase/config.js: TURNSTILE_SITE_KEY = "<site key>"   (public, safe to commit)
   supabase secrets set TURNSTILE_SECRET_KEY=<secret>
   supabase functions deploy lookup-student
   ```
7. Optional — the AI assistant:
   ```bash
   supabase secrets set AI_API_KEY=your_provider_key
   supabase secrets set AI_MODEL=gpt-4o-mini
   supabase secrets set AI_RATE_SALT=<openssl rand -base64 32>
   supabase functions deploy rucuso-ai
   ```
   Any OpenAI-compatible provider works; set `AI_API_BASE_URL` for gateways such as Groq,
   OpenRouter, DeepSeek or Together. Without this step the app still works and the AI button
   falls back to its built-in answers.
8. Push to `main`; GitHub Pages publishes it.

## Running it locally

Any static server works — there is nothing to install:

```bash
python -m http.server 8000     # then open http://localhost:8000
```

`file://` will not work: browsers block cross-origin requests to Supabase from it.

## Deploy

1. Push to `main`.
2. Repo → Settings → Pages → Source: deploy from the `main` branch, root folder.
3. Enforce **HTTPS** once the certificate is issued.

The `CNAME` file already pins this repo to `rucuso.online`; point the domain's DNS at GitHub
Pages per GitHub's "Managing a custom domain" docs. For indexing: add the domain in Google
Search Console, submit `https://rucuso.online/sitemap.xml` under **Sitemaps**, then use
**URL Inspection → Request Indexing**.

## Tests

There is no build step, so the tests run on plain node with no dependencies:

```
node tests/run-all.js
```

That runs every `*.test.js` in `tests/`, then parses the JS the browser loads (`js/*.js`,
`supabase/supabase-client.js`) and every inline `<script>` in the HTML pages, and finally
scans the tree for credentials. Individual suites can be run on their own; the HESLB ones
use the node test runner:

```
node tests/hierarchy.test.js
node tests/assets.test.js
node tests/sql-structure.test.js
node tests/no-secrets.js
node --test tests/heslb-security.test.js
```

| Suite | What it covers |
| --- | --- |
| `otp-oracle.test.js` | Loads the real `lookup-student`, `send-otp` and `verify-otp` sources and calls them against a stub PostgREST. Asserts that known and unknown registration numbers get the same status, the same body and the same work; that no identity field appears before the code is proved; that a phone supplied in a request is never used; that an absent server secret fails closed; and that the uniform responses still leave the reasons in the operator log. It was checked by mutation: reintroducing `found` into the response fails 8 checks, and restoring the fail-open CAPTCHA gate fails 5. |
| `verify-behaviour.test.js` | Runs the real `js/verify-ux.js` in a vm against a stub DOM and calls it. Covers upper-casing and caret preservation, the exact accept/reject set, that every failure returns one message, that the button stays locked without a solved CAPTCHA, the attempt budget, and that no mock approval path exists. |
| `verify-rules.test.js` | Static guarantees over the markup and the bundle: no format in the visible UI, no per-code error message, no secret referenced in the browser, the CAPTCHA gate and the 1.5s spinner floor, and that no existence field survives anywhere in the flow. |
| `hierarchy.test.js` | `refreshHierarchy`, `positionsByTier`, `vacantSlots`, `positionLabel`, and the LIKE escaping in `registrationPattern`. Loads the real `js/data.js` in a vm. |
| `assets.test.js` | Every local `src`/`href` in all 20 pages resolves, every page has a favicon, and the icon files are valid ICO/PNG. |
| `sql-structure.test.js` | Migrations have no unterminated string, dollar-quote or parenthesis, no mixed-case object names, and are numbered in order. |
| `no-secrets.js` | No credential-shaped literal, and no service role key in the committed config. `no-secrets.test.js` proves the scanner would catch one. |
| `heslb-*.test.js` | The HESLB verification, import and page behaviour. |

Two helpers are not suites and are not run by `run-all.js`, because they print
a snapshot rather than asserting:

```
node tests/show-verify-copy.js   # what a student can read on the registration step
node tests/show-rls.js           # the RLS policies
```

`verify-behaviour.test.js` exists because the earlier suite only read
`verify-ux.js` as text and re-ran the regexes it found, which cannot tell you
what `validate()` returns or whether the button actually stays disabled. Writing
it surfaced two real defects on the first run: a mutual recursion between
`setButtonState()` and `renderLimit()` that overflowed the stack on page load,
and a gate that counted a missing Turnstile key as a solved CAPTCHA.

Two helpers are for reading, not for CI: `tests/show-rls.js` prints the policies, grants
and RLS tables in a migration, and `tests/show-config.js` prints the *shape* of the config
values without printing them.

What the tests do **not** cover: nothing here talks to Supabase, so RLS, the triggers, the
Edge Functions and the OTP flow are only verified once they are deployed. Use the checklist
below for those.

## How a data change flows

1. A click in `index.html` calls a function in `js/app.js`.
2. That function asks `js/data.js` to mutate.
3. `js/data.js` calls `RucusoAPI` (`supabase/supabase-client.js`).
4. Only `supabase/supabase-client.js` calls Supabase. It refreshes the in-memory cache and the
   screen re-renders from that cache.

Because step 4 reads from the cache that step 3 just refreshed, a successful write is
immediately visible; a failed write leaves the screen unchanged and surfaces the error as a
toast. Nothing is ever written to `localStorage`.

## Before telling students to use it

- [ ] Sign in as `super_admin`, create a leader, refresh, confirm it is still there — then check
      it appears in the public directory from an incognito window, and that deactivating it
      removes it from the directory but not from the admin list.
- [ ] Submit test feedback, note the reference number, and track it from another browser.
- [ ] Verify a real registration number; confirm a non-existent one is rejected.
- [ ] Sign in as an `admin` with a narrow `permissions` map and confirm the sidebar hides the
      modules it was not granted and those URLs refuse the role.
- [ ] Upload a document and a leader photo; confirm the files load from Supabase Storage.
- [ ] Send an OTP to a real phone; confirm it arrives and expires after 5 minutes.
- [ ] Ask the AI "Nawezaje kuwasilisha malalamiko yangu?" in a private window — it should give
      real instructions. Ask it for a report count as a **visitor** (must refuse: staff-only) and
      then as **staff** (must answer). Ask it for a student's registration number (must refuse).
- [ ] Rename `AI_API_KEY`, reload, ask a question, and confirm you get the Kiswahili
      "not configured yet" message plus the built-in fallback — not a broken chat.
- [ ] Open the home page with the network throttled or the CDN blocked, and confirm the map
      section still shows the address, the coordinates and working "Open in maps" links rather
      than an empty grey box.
- [ ] Turn on "reduce motion" in the OS (Windows: Settings → Accessibility → Visual effects) and
      reload. Cards must sit flat, reveal animations must not run, and the map must still work.
- [ ] On a touch device, confirm the cards do not tilt when swiped — a tilt driven by a finger
      fights with scrolling.
- [ ] Submit the verification form five times with a bad number and confirm the sixth attempt is
      refused with a countdown, and that the limit clears after a minute.
- [ ] Enter a valid number in lower case (`ru/bafit/2024/007`) and confirm it is upper-cased as
      you type, the caret stays put when editing mid-number, and "Endelea" enables. Confirm the
      form never says the number is correct — that would confirm a guess before any request.
- [ ] Enter a number one character short of valid and confirm the button stays disabled. The hint
      must *not* explain which segment is wrong; it may only state the one thing the student can
      act on (CAPTCHA unsolved, or wait for the rate limit).
- [ ] Type nothing, type a malformed number, and type a well-formed number that belongs to nobody.
      All three must produce the same failure sentence. If any of them differ, that difference is
      an enumeration oracle.
- [ ] Inspect the rendered copy of step 1 (`node tests/show-verify-copy.js`). It must contain no
      sample number, no segment names and no quantifiers. There is no control that reveals the
      format — it is not in the page at all, so a student who cannot recall it has to ask the
      office.
- [ ] With `TURNSTILE_SITE_KEY` blank, confirm the form **locks**: the button stays disabled and
      the hint says the security check is unavailable. This is deliberate — see "CAPTCHA fails
      closed" below. With a key set, confirm "Endelea" stays disabled until the widget reports
      success, and re-locks when the token expires.
- [ ] Submit a real number and a number that belongs to nobody, and compare `send-otp`'s two
      responses with devtools open: same status, same body, same shape. Then confirm only the
      real one produced a text message, and that it arrived at the number **on file** — not one
      typed into the form, because there is no longer a field to type one into.
- [ ] With a `TURNSTILE_SITE_KEY` set in `config.js` but no `TURNSTILE_SECRET_KEY` on the
      function, confirm the form refuses with `503 NOT_CONFIGURED` rather than accepting. This is
      the deployment that used to fail open. If you need to work locally without a CAPTCHA, set
      `LOCAL_DEV_SKIP_CAPTCHA=1` and confirm the warning appears in the function log.
- [ ] Submit a real number, then read the response of every request up to the correct code. None
      of them may contain a name, programme, year, faculty, student id or phone number. If any
      detail a student can read says something is not right, that is an enumeration oracle.
- [ ] Submit a real number on a slow connection and confirm the spinner is visible for at least
      1.5s, that the button is never left spinning if the call throws, and that a second click
      during the request does not send a second lookup or spend a second attempt.

## Not built yet

- Voice input for the AI assistant, and a transcript of past conversations in the admin UI
  (questions are already logged in `ai_queries`).
- Representative Portal (campus/faculty/programme/year representation structure).
- Election-ready schema (candidates, positions, voting periods) — intentionally not built, per
  the original spec, until explicitly activated.
- Excel (`.xlsx`) student import; CSV/paste import is implemented.
- Full ministry-scoped RLS for leaders — `has_permission()` and `is_staff()` are in place, and
  migration 013 adds tier- and ministry-scoped access to feedback, but the executive tier's scope
  is still an open decision: `013_leadership_hierarchy.sql` currently sets `sees_all_ministries`
  to true for all six executive posts, where the original intent was `president` and
  `secretary_general` only. **Read that policy before applying the migration** — it is the one
  place in the schema that widens access rather than narrowing it.
- A full Kiswahili/English language switcher (Kiswahili-first; some admin screens are English).
- Real per-section URLs for SEO — all public views share one `index.html`.

## Credits

- Built for Ruaha Catholic University Students' Organization (RUCUSO).
- Vanilla HTML/CSS/JS and Supabase (Postgres, Auth, Storage, Edge Functions).
