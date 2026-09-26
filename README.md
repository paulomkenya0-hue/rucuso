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
| `js/app.js` | Public screen logic and every call into the data layer |
| `js/data.js` | The app's data layer: Supabase loaders/mutators + in-memory cache |
| `js/auth-guard.js` | `window.RucusoGuard.requireRole()` — the shared route guard |
| `supabase/config.js` | Public Supabase URL + anon key (safe to publish; RLS is the boundary) |
| `supabase/supabase-client.js` | `window.RucusoAPI` — the only file that talks to Supabase |
| `supabase/schema.sql` | Migration 001 — tables, RLS policies, first RPCs |
| `supabase/migrations/002_production_backend.sql` | Storage buckets, seeded reference data, closed RLS gaps, `submit_feedback()` |
| `supabase/migrations/003_ai_assistant.sql` | `ai_queries` — the AI rate-limit ledger (no browser policies) |
| `supabase/migrations/004_roles_permissions.sql` | Role/title split, `profiles.permissions`, per-permission RLS |
| `supabase/migrations/005_leader_visibility_and_password_flow.sql` | `leaders.public_visible`, `must_change_password` |
| `supabase/migrations/006_student_phone_verification.sql` | `verify_student_identity()` RPC |
| `supabase/functions/send-otp`, `verify-otp`, `rucuso-ai`, `leader-admin` | Edge Functions |
| `robots.txt`, `sitemap.xml`, `CNAME` | SEO / custom domain |

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
  `lookup_student()` and `verify_student_identity()`; tracking goes through `track_feedback()`.
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
5. Optional — SMS OTP. Set the SMS provider's credentials as Supabase secrets and deploy
   `send-otp` and `verify-otp` (see `supabase/edge-functions-README.md`). Until a provider is
   connected, `REQUIRE_SMS_OTP = false` and verification falls back to the narrower
   phone-on-file check from migration 006.
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

## Not built yet

- Voice input for the AI assistant, and a transcript of past conversations in the admin UI
  (questions are already logged in `ai_queries`).
- Representative Portal (campus/faculty/programme/year representation structure).
- Election-ready schema (candidates, positions, voting periods) — intentionally not built, per
  the original spec, until explicitly activated.
- Excel (`.xlsx`) student import; CSV/paste import is implemented.
- Full ministry-scoped RLS for leaders — `has_permission()` and `is_staff()` are in place, but
  portfolio-level scoping of minister/deputy/representative views is not.
- A full Kiswahili/English language switcher (Kiswahili-first; some admin screens are English).
- Real per-section URLs for SEO — all public views share one `index.html`.

## Credits

- Built for Ruaha Catholic University Students' Organization (RUCUSO).
- Vanilla HTML/CSS/JS and Supabase (Postgres, Auth, Storage, Edge Functions).
