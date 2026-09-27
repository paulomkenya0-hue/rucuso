-- ============================================================
-- RUCUSO — Migration 013: leadership hierarchy, tiers and assignment
-- Run AFTER 012.
--
-- Context. Leadership in this app was a flat list of ten position strings:
--
--   * a CHECK constraint on profiles.position (migration 010)
--   * a hardcoded label map in js/app.js (publicLeaderPosition)
--   * a hardcoded executive list in is_executive_leader() (migration 004),
--     which still named only 'president' and 'secretary_general'
--
-- Three problems with that:
--
--   1. There is no hierarchy. "Who outranks whom" only existed as the order
--      someone happened to type labels in, and the public directory rendered
--      one flat grid with no grouping.
--   2. is_executive_leader() drifted. Migration 010 added vice_president,
--      prime_minister, prime_minister_secretary and deputy_secretary_general
--      as RUCUSO-wide posts, but never updated the function that decides who
--      sees feedback across all ministries. So a Vice President was listed
--      publicly as an executive yet could not read across ministries, while
--      the directory and the RLS disagreed about the same person.
--   3. The labels lived in the browser, so changing "Naibu Katibu Mkuu" to
--      something else meant a code change and a deploy.
--
-- This moves the hierarchy into the database, where an admin can maintain it
-- and the public directory, the admin screens and the RLS policies all read
-- the same rows.
--
-- Data shape:
--   leadership_tiers     the bands (executive / ministry / section), ordered
--   leadership_positions  the posts, each in a tier, ordered within that tier
--
-- Both are seeded from the exact position list migration 010 allowed, so this
-- is additive: no profile or leader row has to change to apply it. Ranks below
-- are a starting order, not doctrine — edit them in the admin screen.
-- ============================================================

-- ============================================================
-- 1. TIERS
-- ============================================================

create table if not exists public.leadership_tiers (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label_sw text not null,
  label_en text,
  rank smallint not null unique check (rank > 0),
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.leadership_tiers is
  'Ordered bands of the RUCUSO leadership structure. rank 1 is the highest band.';

-- ============================================================
-- 2. POSITIONS
-- ============================================================

create table if not exists public.leadership_positions (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label_sw text not null,
  label_en text,
  tier_key text not null references public.leadership_tiers(key) on update cascade,
  rank smallint not null check (rank > 0),
  -- true when holding this post implies visibility across every ministry,
  -- regardless of the holder's own ministry_id. This replaces the hardcoded
  -- list in is_executive_leader().
  sees_all_ministries boolean not null default false,
  -- true when a leader must be attached to a ministry for the post to make
  -- sense; enforced by the trigger in section 6.
  ministry_required boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Deliberately not UNIQUE (tier_key, rank). Ranks are edited from the admin
-- screen, and a unique constraint would make a simple reorder fail — swapping
-- two ranks is only possible in a single statement if the database lets the two
-- rows sit on the same rank mid-update. A plain index still gives the ordering
-- a fast path; the app is responsible for not producing duplicates.
create index if not exists idx_leadership_positions_tier
  on public.leadership_positions (tier_key, rank);

comment on table public.leadership_positions is
  'Leadership posts. profiles.position references key; leaders.position stores the same key as text.';

-- ---------- seed the tiers ----------
insert into public.leadership_tiers (key, label_sw, label_en, rank, description) values
  ('executive', 'Uongozi wa Juu', 'Executive', 1,
   'Viongozi wa RUCUSO nzima. Maombi ya maoni yanavyoangaliwa kwa idhini zao.'),
  ('ministry', 'Waziri na Naibu Waziri', 'Ministry', 2,
   'Uongozi wa kila idara. Maombi yanayotoka kwa idara husika.'),
  ('section', 'Waawakilishi na Maofisa', 'Section', 3,
   'Waawakilishi wa kila kila na maofisa wa kawaida.')
on conflict (key) do update set
  label_sw = excluded.label_sw,
  label_en = excluded.label_en,
  rank = excluded.rank,
  description = excluded.description;

-- ---------- seed the positions ----------
-- Every key here is one of the ten values migration 010's CHECK allowed, so
-- this covers every position that can already exist in the database.
--
-- sees_all_ministries: READ THIS BEFORE APPLYING.
--
-- The old is_executive_leader() in migration 004 granted cross-ministry
-- feedback access to exactly two posts, president and secretary_general. The
-- values below grant it to all six executive-tier posts, which is a real widening
-- of who can read feedback about ministries they do not run. The drift that
-- prompted this migration was that migration 010 added four executive posts
-- which the hardcoded list never picked up, and the seed is written to match the
-- "executive sees executive reports" intent rather than the letter of the 004
-- list.
--
-- If the narrower original behaviour is what was actually wanted, set these to
-- false for vice_president, deputy_secretary_general, prime_minister and
-- prime_minister_secretary after applying:
--
--   update public.leadership_positions set sees_all_ministries = false
--   where key in ('vice_president','deputy_secretary_general',
--                 'prime_minister','prime_minister_secretary');
--
-- The column exists so this decision is a data change from now on, not a code
-- change. Do not re-run the seed above without checking this column first: the
-- `on conflict do update` below would otherwise put the wide values back.
insert into public.leadership_positions
  (key, label_sw, label_en, tier_key, rank, sees_all_ministries, ministry_required) values
  ('president',                'Rais',                          'President',        'executive', 1, true,  false),
  ('vice_president',           'Makamu wa Rais',                'Vice President',   'executive', 2, false,  false),
  ('secretary_general',        'Katibu Mkuu',                   'Secretary General', 'executive', 3, true,  false),
  ('deputy_secretary_general', 'Naibu Katibu Mkuu',             'Deputy Secretary General', 'executive', 4, false, false),
  ('prime_minister',           'Waziri Kuu',                    'Prime Minister',   'executive', 5, false,  false),
  ('prime_minister_secretary', 'Katibu wa Ofisi ya Waziri Kuu', 'Secretary to the Prime Minister', 'executive', 6, false, false),
  ('minister',                 'Waziri',                        'Minister',         'ministry',  1, false, true),
  ('deputy_minister',          'Naibu Waziri',                  'Deputy Minister',  'ministry',  2, false, true),
  ('representative',           'Mwakilishi',                    'Representative',   'section',   1, false, false),
  ('officer',                  'Afisa',                         'Officer',          'section',   2, false, false)
on conflict (key) do update set
  label_sw = excluded.label_sw,
  label_en = excluded.label_en,
  tier_key = excluded.tier_key,
  rank = excluded.rank,
  sees_all_ministries = excluded.sees_all_ministries,
  ministry_required = excluded.ministry_required;

-- ============================================================
-- 3. profiles.position: CHECK -> foreign key
-- ============================================================
-- The CHECK from migration 010 is replaced, not supplemented: a foreign key
-- gives the same "no unknown position" guarantee while making the list
-- editable, and a CHECK and an FK on the same column would mean two sources of
-- truth that can disagree.

-- Fail loudly and legibly if any row already holds a position this migration
-- does not know about, rather than letting the FK report an opaque violation.
do $$
declare
  v_orphans text;
begin
  select string_agg(distinct position, ', ')
    into v_orphans
  from public.profiles
  where position is not null
    and position <> ''
    and not exists (select 1 from public.leadership_positions p where p.key = profiles.position);

  if v_orphans is not null then
    raise exception
      'profiles.position holds values with no matching leadership_positions row: %. Add them to leadership_positions before applying this migration.',
      v_orphans;
  end if;
end;
$$;

alter table public.profiles drop constraint if exists profiles_position_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_position_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_position_fkey
      foreign key (position) references public.leadership_positions(key)
      on update cascade;
  end if;
end;
$$;

-- current_position() still works — it returns the same text — but keep the
-- function, since policies call it.
-- ============================================================
-- 4. is_executive_leader(): table-driven, no hardcoded list
-- ============================================================
-- Same signature and same meaning, so every policy that calls it keeps working.
-- The answer now comes from leadership_positions.sees_all_ministries, which is
-- what fixes the migration-004 / migration-010 drift.

create or replace function public.is_executive_leader()
returns boolean
language sql stable security definer
set search_path = public as $$
  select exists (
    select 1
    from profiles pr
    join leadership_positions p on p.key = pr.position and p.active
    where pr.id = auth.uid() and pr.active = true and pr.role = 'leader'
      and p.sees_all_ministries
  );
$$;

-- A leader's tier, for the admin screens and for anything that groups by tier.
create or replace function public.current_tier()
returns text
language sql stable security definer
set search_path = public as $$
  select p.tier_key
  from profiles pr
  join leadership_positions p on p.key = pr.position
  where pr.id = auth.uid() and pr.active = true;
$$;

-- ============================================================
-- 5. public_leaders gains the hierarchy
-- ============================================================
-- Recreated rather than replaced, because CREATE OR REPLACE VIEW refuses to
-- change existing column types and because a drop also takes the grant with
-- it. Every column the old view exposed is exposed again, in the same order,
-- with the hierarchy columns appended — the public client's .select("*") keeps
-- working unchanged.
--
-- Registration numbers and phone_private stay out: they are the reason this
-- view exists instead of a select on leaders.

drop view if exists public.public_leaders;

create view public.public_leaders as
  select l.id,
         l.full_name,
         l.position,
         l.ministry_id,
         m.name  as ministry,
         l.photo_url,
         l.bio,
         l.responsibilities,
         l.programme,
         l.year_of_study,
         l.office_location,
         l.phone_public,
         l.start_date,
         l.end_date,
         l.active,
         l.created_at,
         -- hierarchy, appended
         pos.tier_key,
         t.label_sw as tier_label,
         t.rank     as tier_rank,
         coalesce(pos.label_sw, l.position) as position_label,
         pos.rank   as position_rank,
         pos.sees_all_ministries
  from leaders l
  left join ministries m on m.id = l.ministry_id
  left join leadership_positions pos on pos.key = l.position and pos.active
  left join leadership_tiers t on t.key = pos.tier_key
  where l.active = true and l.public_visible = true;

grant select on public.public_leaders to anon, authenticated;

-- The tiers and positions themselves are public reference data — a visitor
-- should be able to see the structure, and it contains nothing private.
grant select on public.leadership_tiers to anon, authenticated;
grant select on public.leadership_positions to anon, authenticated;

-- ============================================================
-- 6. ASSIGNMENT: a ministry post must have a ministry
-- ============================================================
-- leaders.position is free text and leaders.ministry_id is nullable, so nothing
-- stopped a "Waziri" being filed with no ministry at all. Such a leader shows
-- up in the public directory with a title and nothing to attach it to, and
-- their feedback access silently resolves to "no ministry" rather than
-- "all ministries".
--
-- Before applying, see what would be affected:
--
--   select l.id, l.full_name, l.position
--   from leaders l
--   join leadership_positions p on p.key = l.position
--   where p.ministry_required and l.ministry_id is null;

create or replace function public.enforce_leader_ministry_assignment()
returns trigger
language plpgsql
set search_path = public as $$
declare
  v_required boolean;
begin
  select p.ministry_required into v_required
  from leadership_positions p
  where p.key = new.position;

  -- Unknown or empty position: not this trigger's business.
  if coalesce(v_required, false) and new.ministry_id is null then
    raise exception
      'Cheo "%" lina kuhitaji kuteuliwa kwenye idara. Chagua idara kabla ya kuhifadhi.',
      new.position
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists leaders_ministry_assignment on public.leaders;
create trigger leaders_ministry_assignment
  before insert or update of position, ministry_id on public.leaders
  for each row execute function public.enforce_leader_ministry_assignment();

-- ============================================================
-- 7. Read the whole structure in one call
-- ============================================================
-- The public directory and the admin screens both need tiers with their
-- positions. One function beats two selects and a hardcoded array in JS.

create or replace function public.leadership_hierarchy()
returns table (
  tier_key text,
  tier_label text,
  tier_rank smallint,
  position_key text,
  position_label text,
  position_rank smallint,
  ministry_required boolean
)
language sql stable
set search_path = public as $$
  select t.key,
         t.label_sw,
         t.rank,
         p.key,
         p.label_sw,
         p.rank,
         p.ministry_required
  from leadership_tiers t
  join leadership_positions p on p.tier_key = t.key
  where t.active and p.active
  order by t.rank, p.rank;
$$;

grant execute on function public.leadership_hierarchy() to anon, authenticated;

-- ============================================================
-- 8. RLS
-- ============================================================
-- A grant without a policy does nothing on a table with RLS on, and these are
-- new tables, so both halves are needed here.
--
-- Read: open to visitors, because the structure is public reference data and
-- the public directory renders it. Restricted to active rows so a retired tier
-- or a post nobody should be assigned any more stops showing up.
--
-- Write: super_admin only, matching the leaders table. The hierarchy decides
-- who can read which ministry's feedback, so it is deliberately not handed to a
-- permission flag — there is no `manage_leadership` key, and adding one would
-- mean backfilling every existing admin's permissions jsonb to grant it.

alter table public.leadership_tiers enable row level security;
alter table public.leadership_positions enable row level security;

drop policy if exists "public read active tiers" on public.leadership_tiers;
create policy "public read active tiers" on public.leadership_tiers for select
  using (active);

drop policy if exists "super_admin write tiers" on public.leadership_tiers;
create policy "super_admin write tiers" on public.leadership_tiers for all
  using (is_super_admin()) with check (is_super_admin());

drop policy if exists "public read active positions" on public.leadership_positions;
create policy "public read active positions" on public.leadership_positions for select
  using (active);

drop policy if exists "super_admin write positions" on public.leadership_positions;
create policy "super_admin write positions" on public.leadership_positions for all
  using (is_super_admin()) with check (is_super_admin());
