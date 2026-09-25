# RUCUSO
**Ruaha Catholic University Students' Organization — Digital Platform (Prototype)**

Academic Year 2026/2027

## Kuhusu / About
RUCUSO ni jukwaa la kidijitali kwa ajili ya uongozi wa wanafunzi, huduma za wanafunzi, na
mfumo wa maoni/malalamiko/changamoto/mapendekezo wa Ruaha Catholic University.

This repository contains the current **front-end prototype** of RUCUSO: a single self-contained
`index.html` file (vanilla HTML/CSS/JS, no build step, no framework) that runs entirely in the
browser. It can be opened directly, or deployed instantly to **GitHub Pages** (see below).

## ⚠️ Important — read before deploying to real students

This prototype stores **all data in the browser's `localStorage`** — there is no shared
server-side database. That means:
- Data is per device/per browser. An admin on one phone will not see submissions made on
  another device.
- The admin login (`admin@rucu.ac.tz` / `admin123`, `officer@rucu.ac.tz` / `officer123`) is a
  **demo login only** — not secure authentication.
- OTP verification is **simulated**: the 6-digit code is shown on-screen (clearly labeled
  DEMO) instead of being sent by real SMS, because there is no backend to hold SMS provider
  credentials.
- There is no Row-Level Security, no real Supabase connection, and no server enforcing
  permissions — everything is enforced in client-side JavaScript only.

**Do not use this as-is to collect real student data or run a real election/leadership
system.** It is a working, clickable prototype of the UI/UX and data model, useful for demos,
stakeholder review, and as a reference for the real backend build.

## Features implemented in this prototype
- Kiswahili-first UI (RUCUSO branding, key screens translated)
- Student verification flow: Registration Number lookup → Tanzania phone number → demo OTP
- Student registry ("Students Database") with manual add, bulk paste import, and CSV import
  (columns: `REGISTRATION NUMBER, FIRST NAME, MIDDLE NAME, LAST NAME, PROGRAMME, YEAR OF STUDY,
  PHONE, EMAIL`)
- Feedback/Complaints/Challenges/Suggestions/Praise submission, with anonymous option,
  attachments (small files, stored as base64), auto-generated reference numbers
  (`RUCU-2026-NNNNNN`), simple anti-spam (math check) and duplicate-submission detection
- Track My Report by reference number, with a status timeline
- Admin dashboard: totals, category/status/ministry breakdowns (simple CSS bar charts),
  recurring-issue grouping (AI-generated suggestion, requires admin confirmation)
- Issue management: filter, view, change status, assign officer, assign ministry, respond,
  internal notes, full audit trail per issue
- Reports: category/status/satisfaction summary, CSV export, PDF export (via jsPDF)
- Leadership Directory: leader cards with photo, position, short bio, and a tap-to-call phone
  number; admin CRUD (add/remove/enable/disable). **Positions are pre-seeded** so you don't
  create leaders from scratch: 4 singular positions (Rais, Makamu wa Rais, Katibu Mkuu, Naibu
  Katibu Mkuu) plus **3 leader slots per ministry** (Waziri, Naibu Waziri, Katibu) — created
  automatically every time you add a new ministry. Empty slots show as "NAFASI WAZI" in the
  admin list; click "Jaza/Hariri" to fill in the real name/phone/bio. Vacant slots are hidden
  from the public-facing directory until filled.
- Ministries (Wizara): configurable list, linked to issues for routing/reporting — adding one
  auto-creates its 3 leader slots (see above)
- Student Services module: configurable list (Mikopo, Malazi, Afya, etc.), inactive by default
  until an admin fills in real details
- Announcements (Matangazo): publish/expiry dates, category, audience, author
- Documents & Resources (Nyaraka): admin file upload (base64, small files), public download list
- Global Audit Log (last 300 actions): logins, verifications, status changes, leader/ministry/
  announcement/document actions, CSV imports
- A rule-based **RUCUSO AI** assistant (Kiswahili) that answers from the data actually in
  `localStorage` and clearly labels `DATABASE FACT` vs `AI-GENERATED SUMMARY` — it is **not**
  a live LLM call; it's a small set of hand-written rules matching common questions.

## Not yet built (needs a real backend — see Roadmap)
- Supabase Postgres schema, Auth, Storage, and Row-Level Security
- Real SMS OTP delivery (Tanzania SMS provider integration)
- Real multi-device/multi-admin shared database
- Leader login portal with forced password change on first login
- Representative Portal (campus/faculty/programme/year representation structure)
- Election-ready schema (candidates, positions, voting periods) — intentionally not built,
  per the original spec, until explicitly activated
- Excel (`.xlsx`) student import (CSV import is implemented; Excel needs a parsing library)
- Full Kiswahili/English language switcher (current UI is Kiswahili-first for the main
  screens; some admin-only screens are still partially in English)
- Server-enforced permissions per role (Minister/Deputy/MP/Representative scoping)

## Running it
Just open `index.html` in a browser — no build step, no dependencies to install locally.
It loads jsPDF from a CDN for PDF export; everything else is self-contained.

### Deploy on GitHub Pages
1. Push this repo to GitHub.
2. Repo → Settings → Pages → Source: deploy from the `main` branch, root folder.
3. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`.

### Custom domain (e.g. rucuso.online)
Add a `CNAME` file to the repo root containing just your domain, and point your domain's DNS
`A`/`ALIAS` records at GitHub Pages per GitHub's documentation, or a `CNAME` record if using a
subdomain.

### Getting it onto Google (SEO / indexing)
This repo already includes `robots.txt`, `sitemap.xml`, a `CNAME` file, and SEO meta tags
(title, description, canonical, Open Graph) in `index.html` — but they all currently use the
placeholder domain **`rucuso.online`**. Before going live:

1. **Replace the placeholder domain everywhere** with your real domain:
   - `CNAME` (just the bare domain, no `https://`)
   - `robots.txt` (the `Sitemap:` line)
   - `sitemap.xml` (the `<loc>` line)
   - `index.html` (`<link rel="canonical">`, `og:url`)
2. Point your domain's DNS at GitHub Pages (A records to GitHub's IPs, or a CNAME record for a
   subdomain — see GitHub's "Managing a custom domain" docs) and enable **Enforce HTTPS** in
   repo Settings → Pages once the certificate is issued.
3. Go to **Google Search Console** (search.google.com/search-console), add your domain as a
   property, and verify ownership — either via a DNS TXT record your domain registrar lets you
   add, or by uploading the HTML verification file Google gives you into this repo's root.
4. In Search Console, submit `sitemap.xml` under **Sitemaps** (e.g.
   `https://rucuso.online/sitemap.xml`).
5. Use **URL Inspection** in Search Console and click **Request Indexing** for the homepage to
   speed things up. Actual appearance in Google search results typically takes anywhere from a
   few days to a few weeks.

Since this is a single-page app (all sections live in one `index.html`, shown/hidden with
JavaScript), there's only one URL for Google to index — that's fine for a small institutional
site, but it means individual sections (e.g. "Uongozi", "Matangazo") won't get their own
separate search results. If you later want each section to rank on its own, that needs real
routing (separate URLs per page), which is part of the backend rebuild described below.

## Phase 2 — Connecting real Supabase (real admin login, real database)

The `supabase/` folder is a starter kit for wiring this front end to a real,
shared, secure backend instead of `localStorage`. You run/own the Supabase
project — I can't create it for you or see your credentials.

1. **Create a project** at supabase.com (free tier is enough to start).
2. **Run the schema**: open your project's SQL Editor, paste in the full
   contents of `supabase/schema.sql`, and run it. This creates every table,
   enables Row Level Security on all of them, and adds two safe RPC
   functions (`lookup_student`, `track_feedback`) so anonymous visitors can
   check a registration number or a reference number without the whole
   students/feedback tables being exposed.
3. **Create your first real admin account** (this is the "username and
   password" you asked for):
   - Dashboard → Authentication → Users → **Add user** — set a real email
     and password.
   - Copy that user's UID, then in the SQL Editor run:
     ```sql
     insert into profiles (id, full_name, role)
     values ('PASTE-UID-HERE', 'Your Name', 'super_admin');
     ```
   - That email + password now logs in for real via Supabase Auth (password
     hashing, sessions — all handled by Supabase, not by this front end).
4. **Get your API keys**: Project Settings → API → copy the Project URL and
   the `anon` public key.
5. **Configure the front end**: copy `supabase/config.example.js` to
   `supabase/config.js` and paste those two values in.
6. **Load the library** in `index.html`, right before your own script tag:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   <script src="supabase/config.js"></script>
   <script src="supabase/supabase-client.js"></script>
   ```
   `window.RucusoAPI` is now available with functions like `adminLogin()`,
   `submitFeedback()`, `trackFeedback()`, `listLeaders()`, etc. — see
   `supabase/supabase-client.js` for the full list.
7. **Real SMS OTP** needs a server-side Edge Function (so your SMS
   provider's API key never sits in browser code) — see
   `supabase/edge-functions-README.md` for ready-to-deploy skeleton code.

### Why `index.html` itself hasn't been rewired yet
`index.html` is a ~2,000-line prototype originally built around `localStorage`.
Three specific flows are now **wired to try real Supabase first, and only
fall back to `localStorage` if `supabase/config.js` hasn't been set up yet**
— so the app works exactly as before out of the box, and automatically
switches to your real backend the moment you add your config:

- **Admin login** (`doLogin`) — tries `RucusoAPI.adminLogin()` (real Supabase
  Auth, real hashed password) first; if Supabase isn't configured, falls
  back to the demo accounts. Once configured, a *wrong* password on a real
  attempt shows a real error rather than silently falling back to demo mode.
- **Student registration-number verification** (`verifyStep1`) — tries the
  `lookup_student` RPC against your real `students` table first, falling
  back to the local Students Database if Supabase isn't configured or the
  student isn't found there yet.
- **CSV student import** (`importStudentsCSV`) — always saves to the local
  registry (so verification keeps working immediately), and *also* pushes
  the same rows to your Supabase `students` table via `bulkUpsertStudents()`
  when configured, so the two stay in sync.

Everything else (feedback submission, tracking, issues, reports, services,
announcements, documents, audit log) still runs on `localStorage` only —
converting those needs matching category/ministry IDs between the two
data shapes and real testing against your project, which I can't do from
here without your live credentials and network access. Once your Supabase
project is up and the three flows above are working for you, tell me and
I'll convert the next batch (feedback submit/track is the natural next
step) the same way — try-Supabase-then-fall-back — so nothing breaks
mid-migration.

To turn this into the real, secure, multi-user RUCUSO platform described in the original
specification, the next phase of work is a genuine backend build (not a browser-only page):
1. Design and create the Supabase Postgres schema (students, users, roles, leaders,
   ministries, feedback, notifications, audit_logs, etc.) with RLS policies per role.
2. Replace `localStorage` calls in this front end with Supabase client calls (`@supabase/
   supabase-js`), keeping the anon key public (RLS enforces security, not secrecy of the key).
3. Wire Supabase Auth for admin/leader accounts; keep the student flow OTP-based via a
   Postgres Edge Function that calls a real Tanzania SMS provider (API keys stored as Supabase
   secrets, never in front-end code).
4. Add Supabase Storage buckets for leader photos, announcement images and documents.
5. Rebuild the Excel import using a library such as SheetJS, with a server-side (Edge
   Function) validation pass before insert.
6. Layer role-based route guards in the front end on top of RLS (defense in depth — RLS is the
   real boundary).

## Credits
Developed by Paulo Mkenya © Ruaha Catholic University
