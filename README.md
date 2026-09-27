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
| `supabase/functions/lookup-student` | Boolean-only registration check. Rate limited per number and per client; optional Turnstile |
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

Until the backfill runs, `lookup-student` also searches
`legacy_registration_number` and answers a legacy-shaped number with
`found:false, reason:"legacy"`. The web form turns that into a specific
message telling the student their record is pending migration and to contact
the office — rather than the "number not found" message they would get for a
genuine typo, which is false and sends them off to re-check a number that was
correct all along.

That response does disclose that a number belongs to a real, unmigrated
student. It is bounded — it is strictly less than identity, and it is rate
limited identically — but if a deployment would rather not disclose even that:

```bash
supabase secrets set MIGRATION_LEGACY_LOOKUP=false
```

which collapses every legacy number to an ordinary not-found. Remove the legacy
branch from `lookup-student` in the same release that finishes the backfill.

### CAPTCHA

Off by default, and the default is not a stub. `supabase/config.js` ships with
`TURNSTILE_SITE_KEY: ""`, and while it is empty the identity check runs on the
server-side rate limits alone — 20 attempts per registration number and 60 per
client per 10 minutes. Those limits are the actual control; the CAPTCHA only
raises the cost of an automated run.

To enable it:

1. Create a Turnstile widget for `rucuso.online` in the Cloudflare dashboard.
2. Put the **site** key in `supabase/config.js`. Site keys are meant to be public.
3. Set the secret on the server — this is the one that must never be in a file:

   ```bash
   supabase secrets set TURNSTILE_SECRET_KEY=<secret>
   supabase functions deploy lookup-student
   ```

`lookup-student` then requires a token and verifies it against Cloudflare's
`siteverify` endpoint **on the server**, before spending any rate-limit budget.
A token checked in the browser is a checkbox, not a CAPTCHA. A site key and
secret that are both empty is a working site; a site key without the matching
secret would reject every student, which is why the key ships blank.

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
  the `lookup-student` Edge Function, which answers only "does this registration number exist?"
  and is rate-limited per number and per client IP; the student's name, programme and year are
  returned by `verify-otp` and only after the SMS code is proved. `lookup_student()` itself is
  `service_role` only as of migration 012. Tracking goes through `track_feedback()`.
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
5. SMS OTP. `REQUIRE_SMS_OTP` in `js/app.js` is `true`, so a real SMS code is mandatory — set the
   provider's credentials as Supabase secrets and deploy the three functions before letting
   students in, or the verification screen will show a failure it cannot recover from:
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
   See `supabase/edge-functions-README.md`. The phone-on-file fallback from migration 006 is
   unreachable while the flag is `true`; turning it back off is a deliberate, documented
   downgrade, not a default.
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
| `hierarchy.test.js` | `refreshHierarchy`, `positionsByTier`, `vacantSlots`, `positionLabel`, and the LIKE escaping in `registrationPattern`. Loads the real `js/data.js` in a vm. |
| `assets.test.js` | Every local `src`/`href` in all 20 pages resolves, every page has a favicon, and the icon files are valid ICO/PNG. |
| `sql-structure.test.js` | Migrations have no unterminated string, dollar-quote or parenthesis, no mixed-case object names, and are numbered in order. |
| `no-secrets.js` | No credential-shaped literal, and no service role key in the committed config. `no-secrets.test.js` proves the scanner would catch one. |
| `heslb-*.test.js` | The HESLB verification, import and page behaviour. |

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
      you type, the caret stays put when editing mid-number, and "Endelea" enables.
- [ ] Enter a number one character short of valid and confirm the button stays disabled *and* the
      hint says why, rather than just going grey with no explanation.
- [ ] With `TURNSTILE_SITE_KEY` set, confirm "Endelea" stays disabled until the widget reports
      success, and re-locks when the token expires. With it unset, confirm the button is governed
      by the number alone.

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
