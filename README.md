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
| `/admin/announcements/` | Create/edit/delete announcements, image upload, draft/schedule/publish, featured | super_admin, admin (manage_announcements) |
| `/admin/parliament/` | Parliament (Wabunge) members: photo, constituency, faculty, year, role, bio, contact, active | super_admin, admin (manage_parliament) |
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
| `js/verify-ux.js` | `window.RucusoVerify` — registration-number rules, attempt budget |
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
| `supabase/functions/lookup-student` | Pre-OTP gate. Rate limited per number and per client, returns `{ok:true}` and nothing else — see "The existence oracle" |
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
  rate-limited per number and per client IP.
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
6. Optional — the AI assistant:
   ```bash
   supabase secrets set AI_API_KEY=your_provider_key
   supabase secrets set AI_MODEL=gpt-4o-mini
   supabase secrets set AI_RATE_SALT=<openssl rand -base64 32>
   supabase functions deploy rucuso-ai
   ```
   Any OpenAI-compatible provider works; set `AI_API_BASE_URL` for gateways such as Groq,
   OpenRouter, DeepSeek or Together. Without this step the app still works and the AI button
   falls back to its built-in answers.
7. Push to `main`; GitHub Pages publishes it.

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
| `otp-oracle.test.js` | Loads the real `lookup-student`, `send-otp` and `verify-otp` sources and calls them against a stub PostgREST. Asserts that known and unknown registration numbers get the same status, the same body and the same work; that no identity field appears before the code is proved; that a phone supplied in a request is never used; that an absent server secret fails closed; and that the uniform responses still leave the reasons in the operator log. It was checked by mutation: reintroducing `found` into the response fails 8 checks. |
| `verify-behaviour.test.js` | Runs the real `js/verify-ux.js` in a vm against a stub DOM and calls it. Covers upper-casing and caret preservation, the exact accept/reject set, that every failure returns one message, the button gate over the number and the attempt budget, and that no mock approval path exists. |
| `verify-rules.test.js` | Static guarantees over the markup and the bundle: no format in the visible UI, no per-code error message, no secret referenced in the browser, the absence of any CAPTCHA and the 1.5s spinner floor, and that no existence field survives anywhere in the flow. |
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
it surfaced a real defect on the first run: a mutual recursion between
`setButtonState()` and `renderLimit()` that overflowed the stack on page load.

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
      act on (wait for the rate limit).
- [ ] Type nothing, type a malformed number, and type a well-formed number that belongs to nobody.
      All three must produce the same failure sentence. If any of them differ, that difference is
      an enumeration oracle.
- [ ] Inspect the rendered copy of step 1 (`node tests/show-verify-copy.js`). It must contain no
      sample number, no segment names and no quantifiers. There is no control that reveals the
      format — it is not in the page at all, so a student who cannot recall it has to ask the
      office.
- [ ] Confirm there is no CAPTCHA in the form at all: a valid number within the rate limit enables
      **Endelea** immediately, with no widget, no token and no security-check message.
- [ ] Submit a real number and a number that belongs to nobody, and compare `send-otp`'s two
      responses with devtools open: same status, same body, same shape. Then confirm only the
      real one produced a text message, and that it arrived at the number **on file** — not one
      typed into the form, because there is no longer a field to type one into.
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


## Migration 018 — announcements + Parliament

Run `supabase/migrations/018_announcement_management_and_parliament.sql` once in the
Supabase SQL editor. It is additive: existing announcements keep showing (status defaults to
`published`). It adds announcement `status`/`featured`/`image_path`, the validated
`save_announcement()` RPC, the `parliament_members` table with the `public_parliament_members`
view (phone/email are public only when `contact_public` is ticked), the `announcement-images`
and `parliament-photos` buckets, and a MIME allow-list (JPG/PNG/WebP, no SVG) on the public
`leader-photos` and `rucu-documents` buckets. Admins need the `manage_parliament` permission
to manage Parliament; super_admin has it implicitly.


## Study Hub (migration 019)

Run `supabase/migrations/019_study_hub.sql` in the same Supabase project before
opening `/study/`. It adds a moderated catalogue of HTTPS material links and
material requests; no sample records, file uploads or paid storage are required.

Students can browse without signing in and submit a material link or request.
All submissions start pending. `/admin/study/` lets active staff with the existing
`manage_documents` permission (including super admins) publish, reject or return
items to review. Review the link, sharing permission, subject and source manually.
An approved request can be returned to review once the material has been supplied.
Only approved records can be read publicly; no contact information is collected.
The anonymous submission RPC has a shared limit of 200 submissions per database
calendar day, so one abusive caller can exhaust it. This is a starter queue cap,
not a per-student rate limit; authenticated or verified submissions can replace
it if traffic warrants it. External file owners control availability and access.
Public search is by title/subject, with course/type filters and pages of 24.

Start content collection with one volunteer per course/year: ask for notes they
own or have permission to share and released past papers, then review before
publication. Avoid live or confidential examinations and personal information.


## Student Community (migration 020)

Run `supabase/migrations/020_student_community.sql` after the previous migrations.
The public entry is `/community/`; staff use `/staff/student-services/`.

### Security intake and staff accounts

The migration reuses a ministry whose active name contains `ulinzi` or `security`
(or adds `Wizara ya Ulinzi`) and adds the `ministry_secretary` leadership position.
In `/staff/student-services/`, a super admin must confirm the intended security
ministry, especially if more than one matching ministry exists. Under
`/admin/leaders/`, create or update the three real leaders with unique usernames:
`minister`, `deputy_minister`, and `ministry_secretary`, all assigned to that same
ministry. Existing leader account creation issues a temporary password and forces
its change. No placeholder people, passwords or real accounts are created by SQL.
The existing `leader-admin` Edge Function must already be deployed.

Security reports are PRIVATE: only those active security leaders and super admins
can read them. Other leaders, normal admins and students cannot read the table.
Each report gets an unguessable tracking token in addition to a reference; both
are required to read its status and public replies. Save both at submission time:
they are not automatically retained on the student's device. The hostel list is
Nkembo/Katikaza (boys), NMB line/Kamzora/Sisters/Elizabeth (girls), Lugalo, or a
manually entered off-campus/external-hostel location. Confirm hostel spelling
before launch. Reports collect self-reported names, course, year and contact data.
They enter the security team's shared inbox immediately; its new-report counter
refreshes every 30 seconds while the staff page is open. There are no SMS, email
or background push notifications. The 24-hour indicator is a FIRST RESPONSE
TARGET, not a resolution guarantee or automatic closure. Every staff response
records a history entry with the acting account.

### First-year feedback

The feedback entry asks for year. Year 1 gets a manual, explicitly unverified
form; years 2–4 are sent to the existing registration/last-name flow using
`/?feedback_year=<year>#submit`. Existing homepage feedback buttons also use the
year gate. Self-declaring year 1 is not proof of enrolment; this manual feedback
never creates a verified student identity or grants access to chat. First-year
feedback can be read and answered by super admins, admins with `manage_feedback`,
and authorized executive leaders. The existing verified feedback table is unchanged.

### Student group chat

Chat uses **Continue with Google**; students do not enter email/password on this
page. In Google Auth Platform create a Web OAuth client with origin
`https://rucuso.online` and the exact callback URI shown by the Supabase Google
provider (normally `https://<project-ref>.supabase.co/auth/v1/callback`). Enable
Google in Supabase Auth and paste its Client ID and Client Secret into that
provider's dashboard settings. Never put the Client Secret in the repository.
Allow `https://rucuso.online/community/` in Supabase Auth redirect URLs. Configure
Google Audience as External, add testers during testing and publish for students
when ready. Request only the standard identity scopes (openid/email/profile).
Google identity proves access to a Google account, not university membership.
Keep the Email provider enabled if existing leaders/admins use passwords; the
student chat page no longer offers password registration or login. Existing
membership records and staff logins do not need a database migration for this change.
Students submit separate community membership applications. Every application
starts pending; admins with `manage_feedback` (including super admins) must check
identity/registration themselves before approval. First-year members need manual
checking because no first-year register is available. Students never get rows in
staff `profiles` and cannot promote themselves. Approved members can read and send
text messages; suspended/pending users cannot. Other members see the chosen display
name, text and time, not account UUIDs, email, phone or registration numbers.
There is one shared group, not direct messages, calls or end-to-end encryption.
New messages are checked every 8 seconds in an open, visible page. Moderators can
remove messages, review reports and suspend memberships. Browser text rendering
escapes untrusted content by using textContent. Server-side message limits are
one per 3 seconds and 120 per member/hour. Anonymous intake and membership each
have shared daily caps of 200: these are bounded starter queues, not per-IP limits.

### Deployment checks

After applying SQL, create/assign the actual leader accounts and check routing.
Test a private security report as a student; verify that only the three assigned
leaders and super admin can see it, and test tracking with a wrong token. Check
first-year feedback and the year 2–4 redirects. Use two student auth accounts to
check pending/approved/suspended chat access and moderation. No production data or
leader credentials are needed for the bundled local tests. This migration has to
be applied and live RLS/Auth behavior verified on the target Supabase project.


## Current-event sports registration (migration 021)

Apply `supabase/migrations/021_sports_registration.sql` to enable `/sports/` and
`/admin/sports/`. This is one current event, not a permanent talent registry.
No sports approval or Google sign-in is required for student registration.

The form collects first/middle/last name, a normalized RU/ registration number,
phone, course, year 1–4, gender and one or more of the ten supplied sports. A
unique registration number prevents duplicate entries. The RU/ shape check is
not an enrolment database check. Each student is one registration, with multiple
sports selections; the total student count does not add those selections twice.
All student data is private under RLS and the roster RPC. Only an active leader
with `position=minister` in the configured sports ministry, or a super admin,
can see or export students. Deputies, secretaries and ordinary admins are denied,
even if they have permissions for other modules. Public RPC returns only event
metadata, sport labels and aggregate counts.

The migration reuses an active ministry containing `michezo`/`sport`, or creates
Wizara ya Michezo. Super admin must verify the routing ministry on `/admin/sports/`
and assign the real sports minister's existing leader account to that ministry.
Only super admin can change the title, open/close registration or set a deadline.
Deadline input is interpreted in Africa/Dar_es_Salaam (UTC+03:00); leave blank to
close manually. Registration starts open with no invented deadline. The event row
is locked during submission so closure/duplicates cannot be bypassed by races.
The shared daily queue cap is 5,000 sign-ups; it is not per-IP throttling.

The minister and super admin can filter by sport, gender, course substring and
year. Both exports fetch ALL matching rows in pages of 250, rather than exporting
only the visible page. Excel is a real .xlsx OOXML workbook with text cells, so
phone zeros and registration numbers survive, and values cannot become formulas.
PDF uses jsPDF 4.2.1, A4 landscape, wrapped rows, repeated headers and page numbers.
The PDF library loads from jsDelivr; Excel generation has no external library.
Keep exported student lists private and use them only for organizing this event.

Local checks cover intake/duplicates/closure, multi-sport selection, restricted
roster access, multi-page filtered export, XLSX parsing (openpyxl), and PDF page
layout. Apply SQL and verify real roles/exports against the target project before
sharing the public registration link.


## Education feedback

Apply `supabase/migrations/023_education_feedback.sql` in the Supabase SQL editor,
then deploy the frontend. Public intake and secret-code tracking are at
`/education/`; the private inbox is at `/admin/education/`.

Only an active super admin and the active Education minister (leader role,
minister position, configured Education ministry) can read and respond. Deputies,
secretaries, ordinary admins and other ministries cannot access the inbox.
Super admin must verify the Education ministry routing in the inbox settings and
assign the real minister's existing leader account to that ministry.

Anyone may submit manually as Student, CR, MP or Minister. A selected role is
self-declared until verified against the signed-in account. Super admin can link
an existing auth account UUID to a checked CR or an existing active Parliament
member. The public page displays the signed-in user's account ID for this setup.
Minister verification uses the active staff profile. A verified role does not
verify enrollment or every contact field; previous submissions retain their
original verification snapshot. No role selection grants inbox privileges.

Optional Google sign-in requires `https://rucuso.online/education/` in the
Supabase Auth redirect allowlist. Submission itself does not require Google or
chat membership. Evidence is an optional HTTPS link, not a file upload. Keep
reference and secret token together to track status and replies. The shared
submission cap is 500 per day, not per-IP throttling or a response-time promise.

Run `node tests/run-all.js` for frontend/contract checks. The optional isolated
PostgreSQL test uses fabricated data only: set `RUCUSO_PGLITE_PATH` to an installed
`@electric-sql/pglite` package and run
`node tests/education-postgres.integration.js`. It checks migration repeatability,
real database roles/RLS, restricted RPCs, forged role claims, account links,
secret tracking, replies and closure. Production SQL and accounts must still be
configured in the target project.

## Pending loan payment samples

Apply `supabase/migrations/024_loan_pending_samples.sql` in Supabase SQL Editor,
then deploy the frontend. Public form: `/loan-pending/`; private roster:
`/admin/loan-pending/`. Existing HESLB beneficiary data/permissions are unchanged.

The intake contains only full name (at least three name parts), RU registration
number, Form Four Index Number (`S1234.0001.2024` or `P1234.0001.2024`), bank
(CRDB/TCB/NMB/Other with name), bank account number and consent. There is no cheque
number, date, description, phone or card-number field. Bank account numbers are
text, preserving leading zeros. Format validation is not proof of enrollment,
account ownership, bank correctness or HESLB payment state. There is no bank or
HESLB integration and no promised payment date.

Only active super admins and active leaders whose position is `minister` in the
configured active Loans ministry can list, reveal or export. Deputies,
secretaries, ordinary admins, executive leaders and other ministries are denied.
Do not reuse the broader `is_heslb_manager` permission for this module. Super
admin must verify the ministry routing in the roster settings, and assign the
real Loans minister's existing leader account to that ministry. Only super admin
can change routing or close/reopen intake.

Anonymous/manual submission does not require Google sign-in. Repeated reg/index
submissions return the same generic acknowledgment, without overwriting an
existing account or disclosing the existing record. Corrections must be handled
with the authorized ministry after verifying the student; there is no public
edit endpoint. Intake is serialized with closure and a shared cap of 500 new
records per Dar es Salaam day. This is not per-IP throttling or identity proof.

Private lists contain masked account numbers. Authorized reveal and full-account
export requests are logged in `loan_pending_access_log`, with no direct client
access to the log or base tables. Excel/PDF export all matching bank-filtered
pages, including full account numbers. Keep exported files with the authorized
handlers. Excel uses inline text cells to preserve zeros and avoid formulas.
PDF loads jsPDF 4.2.1 on demand from jsDelivr; Excel has no CDN dependency.

`node tests/run-all.js` includes intake, access-gate, masked-account, export,
XML/XLSX and wiring checks. The optional real PostgreSQL-engine integration test
uses fabricated identities/data only:
`RUCUSO_PGLITE_PATH=/path/to/@electric-sql/pglite node tests/loan-pending-postgres.integration.js`.
It tests direct-table and RPC denial, exact roles, validation, S/P formats,
duplicate non-overwrite, account zeros, reveal/export logs, multi-page exports,
closure, active ministry checks and idempotent migration. Apply production SQL
and configure accounts in the target project before distributing the link.
