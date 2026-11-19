# Leader accounts and private ministry inboxes

This change fixes two separate gaps: directory-only SQL imports had no Auth
credentials, and the main public feedback form always submitted a null ministry.
The existing directory and its photographs/biographies are reused; this change
never runs the private directory import again or resets existing passwords.

## Install

1. Apply the patch to the current repository.
2. Run `supabase/migrations/026_staff_accounts_and_ministry_inboxes.sql` in the
   target Supabase SQL Editor after migrations 020, 021, 023, 024 and 025.
3. Deploy the changed Edge Functions:
   `npx supabase functions deploy leader-admin rucuso-ai --use-api --remote=ratxhdnjigwuehcrzosm`.
   Supabase CLI authentication must be available. No service key goes in browser
   code or GitHub; the existing server environment supplies it.
4. Run `node tests/run-all.js`, then commit/push the frontend and source changes.

## Super admin workflow

On `/admin/leaders/`, the existing accounts retain Edit, Reset Password,
Activate/Deactivate and Delete actions. A new section lists directory rows
without linked accounts. Choose a unique username and click **Unda akaunti**.
The server confirms the caller is super admin and loads position/ministry from
that existing directory ID; caller-supplied role/position/ministry fields are
ignored. A new Auth user is linked to the same directory row with a service-only,
transactional PostgreSQL function. Existing photographs, bio and registration
numbers are untouched. The temporary password is shown once and is never in
an audit log. Deliver it privately; the leader must change it on first login.
Reset Password is available after the account exists.

Inactive rows and likely existing accounts are flagged, not auto-provisioned.
The database locks the directory row and leadership slot to prevent duplicate
claims. Failed provisioning deletes only the newly created Auth user. An
existing account in the same active leadership slot requires manual review;
never delete the legitimate account merely to make provisioning succeed.
Leader-account actions cannot target a super-admin or student profile.

Open `/admin/ministry-routing/` to check Education, Security, Sports and Loans.
For each service, choose its actual active ministry and verify that an active
`leader` / `minister` account belongs to that ministry. The page shows the
number of active minister accounts. Directory records and login profiles are
separate: adding a public name does not automatically authorize a login.
Security route changes also transfer its existing lost/found cases to the new
selected Security ministry, serialized against new security submissions.
No roles or directory assignments are silently changed by the migration.

## Private submissions

The main public form and manual first-year form now include a ministry selector.
A selected active ministry receives the report; an unselected/general matter is
visible only to super admin. Security intake always uses the server's configured
Security ministry, ignoring a caller-supplied replacement. The specialist
Education, Sports and Loans forms continue to use server-owned routing.

An active **minister of the responsible active ministry** and **super admin**
are the only viewers/responders for private submissions. Deputies, secretaries,
ordinary admins (even with old view/manage-all flags), executives of other
positions and students do not gain access to these inboxes. Old permissive RLS
policies are constrained by new restrictive policies on feedback, histories,
notes and attachments. Private evidence downloads/signed URLs are scoped too.
Password-change-required accounts cannot access ministry submissions until
that flag is cleared through the existing password-change flow.

`/leader/dashboard/` now shows **Majukumu na Inbox Yangu**, with authorized
module links, totals and new-report counts. `/leader/inbox/` reads/replies to
routed general feedback, with atomic reply/status history. Super admin can use
**Elekeza wizara** there to route old unassigned feedback deliberately. Historical
unassigned general/first-year reports are not assigned based on guessed text.
Existing student directory/announcement executive features are unchanged.

New general feedback gets a reference plus private tracking token. A token is
required to read the minister's reply. Old reference-only tracking continues to
show status/metadata, without reply content; references alone were enumerable.
Existing specialist forms retain their existing secret tracking. AI aggregate
statistics across all ministries are now included only for super admin.

## Validation

`node tests/run-all.js` includes real Edge Function handler tests with fabricated
Supabase/Auth clients, permission checks, directory-only account provisioning,
rollback, credential delivery, account-role protection and portal UI contracts.
The standalone PostgreSQL integration uses fabricated local data only:

```
RUCUSO_PGLITE_PATH=/path/to/@electric-sql/pglite node tests/staff-routing-postgres.integration.js
```

It applies real module migrations and the new migration twice, then exercises
restrictive RLS despite broad legacy policies, each minister's inbox, denied
cross-ministry replies, child records/private storage, module permissions,
first-year routing, secret reply tracking, super-admin routing and service-only
profile provisioning. No live student data is read. Apply SQL, deploy functions,
and verify configured production accounts before sharing credentials.

## Updated access: migration 027

Apply `027_deputy_ministry_access.sql` after 026. An active `deputy_minister`
now has the same student inbox/reply/export access as the `minister` in that
same active ministry. This overrides the minister-only description above;
secretaries, ordinary admins, other ministries and students remain excluded.
Super-admin-only settings, account administration and representative verification
remain super-admin-only. No existing passwords are reset.

The separate owner-run `supabase/admin/security_leadership_handover_2026.sql`
applies the requested Security personnel handover using strict identity checks,
private snapshots and an idempotency marker. It stops for ambiguous names or
account links. It reuses Mahfudhi's existing directory/account, deactivates the
outgoing minister, and creates or reuses Osca's directory entry without inventing
credentials, registration numbers, contacts or images. If Osca has no account,
create it from the directory-only section on `/admin/leaders/`.
