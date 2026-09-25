# RUCUSO
**Ruaha Catholic University Students' Organization — Digital Platform**

Academic Year 2026/2027

## Kuhusu / About
RUCUSO ni jukwaa la kidijitali kwa ajili ya uongozi wa wanafunzi, huduma za wanafunzi, na
mfumo wa maoni/malalamiko/changamoto/mapendekezo wa Ruaha Catholic University.

RUCUSO is a static site (vanilla HTML/CSS/JS, no build step, no framework) whose data now
lives in **Supabase Postgres**, not in the browser. Any admin change made on one device is
visible to every other device immediately.

Production: **https://rucuso.online** — deployed from `main` via GitHub Pages.

## Repository layout
| Path | Purpose |
| --- | --- |
| `index.html` | All markup, CSS and screen structure |
| `js/app.js` | All screen logic and every call into the data layer |
| `js/data.js` | The data layer: Supabase loaders/mutators + the in-memory cache |
| `supabase/config.js` | Public Supabase URL + anon key (safe to publish; RLS is the boundary) |
| `supabase/supabase-client.js` | `window.RucusoAPI` — the only file that talks to Supabase |
| `supabase/schema.sql` | Migration 001 — tables, RLS policies, first RPCs |
| `supabase/migrations/002_production_backend.sql` | Migration 002 — hardening, storage buckets, `submit_feedback()` |
| `supabase/functions/` | Edge Functions for real SMS OTP |
| `robots.txt`, `sitemap.xml`, `CNAME` | SEO / custom domain |

## What still lives in the browser
Exactly two `localStorage` keys, neither of which is shared application data:
- `rucu_student_session_v1` — the student's own verified session, so a page refresh does not
  force them to re-enter an SMS code.
- `rucu_ui_v1` — UI preferences (theme).

Everything else — leaders, ministries, services, announcements, documents, feedback, issues,
students, categories, programmes, contacts and the audit log — is read from and written to
Supabase on every load. **There is no localStorage fallback**: if Supabase is unreachable the
app says so and refuses to pretend the operation succeeded.

## Security model
- Supabase Auth is the only authentication. No passwords are stored in the browser, and no
  demo accounts exist.
- Every admin/leader account needs a row in `profiles`. Without one, login succeeds but the
  app shows "Akaunti hii haina profili ya msimamizi" and nothing else is possible.
- Permissions are enforced by **Row Level Security**, not by JavaScript. The front end's route
  guards are only a convenience on top of that.
- The public cannot read the `students` or `feedback` tables. Student lookups go through
  `lookup_student()`, and tracking goes through `track_feedback()`.
- Public submissions go through `submit_feedback()`, which mints the reference number,
  enforces anonymity server-side, and blocks duplicate spam inside the database.
- The public leadership directory reads a dedicated `public_leaders` view, so the leaders'
  registration numbers and private phone numbers are never exposed to visitors.
- Feedback attachments live in a **private** storage bucket; staff open them through a
  short-lived signed URL.
- The `service_role` key exists only inside the OTP Edge Functions, as a Supabase secret.

## Setup / deployment order
1. Run `supabase/schema.sql` (001) in the SQL Editor — only needed once, on a new project.
2. Run `supabase/migrations/002_production_backend.sql` in the SQL Editor. **This one is
   required for the live site**: it creates the storage buckets, seeds the categories and
   student services, closes four RLS gaps and adds `submit_feedback()`.
3. Create the first real admin:
   - Dashboard → Authentication → Users → **Add user** (real email + password)
   - then, in the SQL Editor:
     ```sql
     insert into profiles (id, full_name, role)
     values ('<paste-the-uid>', 'Jina Lamili', 'super_admin')
     on conflict (id) do update set role = excluded.role;
     ```
4. Set the OTP secrets and deploy the Edge Functions (see
   `supabase/edge-functions-README.md`).
5. `supabase/config.js` must contain the project URL and anon key. It is committed on purpose:
   the anon key is public by design and is only safe because RLS is on every table. Never put
   a `service_role` key in it.
6. Push to `main`; GitHub Pages publishes it.

## Verification checklist (do this before telling students to use it)
- [ ] Log in as `super_admin` in a normal window, create a leader, refresh, and confirm it is
      still there.
- [ ] Open the site in an incognito window and confirm the leader appears in the directory.
- [ ] Edit the leader, refresh, confirm the edit persisted.
- [ ] Deactivate the leader, confirm it disappears from the public directory but stays in the
      admin list; re-activate it.
- [ ] Delete a test leader and confirm it is gone from both.
- [ ] Create a ministry, refresh, confirm it persisted.
- [ ] Submit a test feedback, note the reference number, and track it from another browser.
- [ ] Verify a student registration number, and confirm a non-existent one is rejected.
- [ ] Log in with a non-admin account and confirm it cannot change any protected data.
- [ ] Upload a document and a leader photo, and confirm the files load from storage (not from
      base64 in localStorage).
- [ ] Send an OTP to a real phone and confirm the code arrives and expires after 5 minutes.
## Features
- Kiswahili-first UI (RUCUSO branding, key screens translated)
- Student verification: registration-number lookup → Tanzania phone → **real SMS OTP**
  (Edge Function, hashed codes, 5-minute expiry, 5-attempt limit, per-phone rate limiting)
- Feedback/Complaints/Challenges/Suggestions/Praise submission with anonymous option,
  a private attachment, an auto-generated reference number (`RUCU-2026-XXXXXX`), a math
  anti-spam check and duplicate detection **enforced in the database**
- Track My Report by reference number, with a status timeline and category
- Admin dashboard: totals, category/status/ministry breakdowns (CSS bar charts), recurring
  issue grouping with an AI-generated suggestion that an admin must confirm
- Issue management: filter, view, change status, assign officer, assign ministry, respond,
  internal notes, full audit trail per issue
- Reports: category/status/satisfaction summary, CSV export, PDF export (jsPDF)
- Leadership Directory: photo, position, short bio and a tap-to-call number for public users;
  admin CRUD. Positions are pre-seeded (4 singular posts + 3 slots per ministry, created
  whenever a ministry is added). Empty slots show as "NAFASI WAZI" and click "Jaza/Hariri" to
  fill in the real name, phone and bio. Vacant slots are hidden from the public directory.
- Ministries (Wizara): configurable, linked to issues for routing and reporting
- Student Services module: configurable list (Mikopo, Malazi, Afya, ...), inactive until an
  admin fills in real details
- Announcements (Matangazo): publish/expiry dates, category, audience, author
- Documents & Resources (Nyaraka): admin file upload to Supabase Storage, public download list
- Global Audit Log: logins, verifications, status changes, leader/ministry/announcement/
  document actions, CSV imports
- A rule-based **RUCUSO AI** assistant (Kiswahili) that answers from the data actually in
  the database and labels `DATABASE FACT` vs `AI-GENERATED SUMMARY` — it is **not** a live
  LLM call, just hand-written rules matching common questions

## Not yet built
- Real LLM-backed AI (the current assistant is rule-based on purpose: no API key, no cost)
- Leader login portal with forced password change on first login
- Representative Portal (campus/faculty/programme/year representation structure)
- Election-ready schema (candidates, positions, voting periods) — intentionally not built, per
  the original spec, until explicitly activated
- Excel (`.xlsx`) student import (CSV/paste import is implemented; `.xlsx` needs a parser)
- Per-role scoping (Minister/Deputy/MP/Representative see only their own portfolio) — RLS
  currently draws a single line between "staff" and "public"
- Full Kiswahili/English language switcher (Kiswahili-first; some admin screens are in English)
- Real per-section URLs for SEO (all sections share one `index.html`)

## Running it
Just open `index.html`, or serve the folder with any static server:
```
python -m http.server 8000     # then open http://localhost:8000
```
`file://` will not work — browsers block cross-origin requests to Supabase from it. There is
no build step and nothing to install. jsPDF comes from a CDN for PDF export.

`supabase/config.js` must be present and filled in, otherwise the app loads but every screen
shows the "database unreachable" state on purpose.

## Deploy on GitHub Pages
1. Push to `main`.
2. Repo → Settings → Pages → Source: deploy from the `main` branch, root folder.
3. Enforce **HTTPS** once the certificate is issued.

The `CNAME` file already pins this repo to `rucuso.online`; point the domain's DNS at GitHub
Pages per GitHub's "Managing a custom domain" docs.

### SEO
`robots.txt`, `sitemap.xml`, `CNAME` and the meta tags (title, description, canonical, Open
Graph) are in the repo and already reference `rucuso.online`. For indexing:
1. Google Search Console → add the domain as a property and verify via a DNS TXT record or the
   HTML verification file in the repo root.
2. Submit `https://rucuso.online/sitemap.xml` under **Sitemaps**.
3. Use **URL Inspection → Request Indexing** on the homepage.

All screens share one `index.html`, so there is a single URL to index. Individual sections will
not get their own search results until real routing is added.

## How a data change flows
1. A click in `index.html` calls a function in `js/app.js`.
2. That function asks `js/data.js` to mutate.
3. `js/data.js` calls `RucusoAPI` (`supabase/supabase-client.js`).
4. Only `supabase/supabase-client.js` calls Supabase. It refreshes the in-memory cache and the
   screen re-renders from that cache.

Because step 4 reads from the cache that step 3 just refreshed, a successful write is
immediately visible; a failed write leaves the screen unchanged and surfaces the error as a
toast. Nothing is ever written to `localStorage`.

## Credits
- Built for Ruaha Catholic University Students' Organization (RUCUSO).
- Vanilla HTML/CSS/JS, Supabase (Postgres, Auth, Storage, Edge Functions), jsPDF.
