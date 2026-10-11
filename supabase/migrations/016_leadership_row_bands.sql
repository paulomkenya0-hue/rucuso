-- ============================================================
-- RUCUSO — Migration 016: leadership bands split for the row directory
-- Run AFTER 015.
--
-- The public directory renders the leadership structure as one horizontal row
-- per band, top to bottom, so the bands have to be finer than the original
-- three (executive / ministry / section). They become five:
--
--   1. executive         Uongozi wa Juu
--   2. ministers         Mawaziri
--   3. deputy_ministers  Manaibu Waziri
--   4. secretaries       Makatibu wa Wizara
--   5. section           Waawakilishi na Maofisa
--
-- No profile or leader row changes: the two existing ministry posts are moved
-- into the new bands, and the missing posts are added: ministry_secretary
-- (Katibu wa Wizara), deputy_speaker (Naibu Spika) and the three executive
-- posts (attorney_general, deputy_attorney_general, presidential_advisor) that
-- the admin leaders form could already choose but 013 never created. Every key
-- matches an option the form already offers, so creating those leaders stops
-- failing the profiles -> leadership_positions foreign key.
--
-- is_executive_leader() reads leadership_positions.sees_all_ministries. The new
-- executive posts are seeded with that column false and it is deliberately left
-- out of their `on conflict do update`, so adding a post neither widens who may
-- read across ministries nor undoes a later manual decision.
-- ============================================================

-- 1. Make room on the unique rank ladder. 'section' stays last; the old
--    'ministry' band is parked out of the way until it is deleted in step 5.
update public.leadership_tiers set rank = 5  where key = 'section' and rank <> 5;
update public.leadership_tiers set rank = 90 where key = 'ministry' and rank <> 90;

-- 2. Create the bands that carry the split-out posts.
insert into public.leadership_tiers (key, label_sw, label_en, rank, description) values
  ('ministers',        'Mawaziri',           'Ministers',           2, 'Mawaziri wa kila wizara.'),
  ('deputy_ministers', 'Manaibu Waziri',     'Deputy Ministers',    3, 'Wanaibu wa mawaziri wa kila wizara.'),
  ('secretaries',      'Makatibu wa Wizara', 'Ministry Secretaries', 4, 'Makatibu wa kila wizara.')
on conflict (key) do update set
  label_sw = excluded.label_sw,
  label_en = excluded.label_en,
  rank = excluded.rank,
  description = excluded.description,
  active = true;

-- 3. Move the two existing ministry posts into their own bands.
update public.leadership_positions
   set tier_key = 'ministers'
 where key = 'minister' and tier_key <> 'ministers';

update public.leadership_positions
   set tier_key = 'deputy_ministers'
 where key = 'deputy_minister' and tier_key <> 'deputy_ministers';

-- 4. Add the ministry secretary post. A secretary belongs to a ministry, the
--    same way a minister does, so ministry_required is true and the trigger
--    from migration 013 enforces that a ministry is chosen.
insert into public.leadership_positions
  (key, label_sw, label_en, tier_key, rank, sees_all_ministries, ministry_required) values
  ('ministry_secretary', 'Katibu wa Wizara', 'Ministry Secretary', 'secretaries', 1, false, true)
on conflict (key) do update set
  label_sw = excluded.label_sw,
  label_en = excluded.label_en,
  tier_key = excluded.tier_key,
  rank = excluded.rank,
  sees_all_ministries = excluded.sees_all_ministries,
  ministry_required = excluded.ministry_required,
  active = true;

-- 5. Retire the old 'ministry' band. The guard makes the delete a no-op if a
--    post was somehow left pointing at it, rather than failing the migration.
delete from public.leadership_tiers
 where key = 'ministry'
   and not exists (select 1 from public.leadership_positions p where p.tier_key = 'ministry');

-- 6. Executive posts the admin leaders form can choose but migration 013 never
--    created. Without these rows a super admin picking one hits the
--    profiles -> leadership_positions foreign key and the leader is not created
--    at all. ('speaker' is already seeded by 013.)
--
--    a. Seat the Deputy Speaker (Naibu Spika) beside the Speaker. 013 puts
--       'speaker' at executive rank 6, so 'prime_minister_secretary' is nudged
--       down one slot to make room and deputy_speaker is inserted at rank 7.
--       The index on (tier_key, rank) is not unique (see migration 013), so the
--       renumber is safe.
update public.leadership_positions
   set rank = 8
 where key = 'prime_minister_secretary' and tier_key = 'executive' and rank <> 8;

insert into public.leadership_positions
  (key, label_sw, label_en, tier_key, rank, sees_all_ministries, ministry_required) values
  ('deputy_speaker', 'Naibu Spika', 'Deputy Speaker', 'executive', 7, false, false)
on conflict (key) do update set
  label_sw = excluded.label_sw,
  label_en = excluded.label_en,
  tier_key = excluded.tier_key,
  rank = excluded.rank,
  ministry_required = excluded.ministry_required,
  active = true;

--    b. The three remaining executive posts (Attorney General etc.).
--
--    sees_all_ministries stays false and is deliberately NOT in the update set:
--    adding a post must not silently widen who may read across ministries, and
--    re-running this seed must not undo a manual decision made afterwards.
--    (As with the Deputy Speaker: executive row for display, no cross-ministry
--    read access until an admin flips the column on purpose.)
insert into public.leadership_positions
  (key, label_sw, label_en, tier_key, rank, sees_all_ministries, ministry_required) values
  ('attorney_general',        'Mwanasheria Mkuu',       'Attorney General',        'executive', 9,  false, false),
  ('deputy_attorney_general', 'Naibu Mwanasheria Mkuu', 'Deputy Attorney General', 'executive', 10, false, false),
  ('presidential_advisor',    'Mshauri wa Rais',        'Presidential Advisor',    'executive', 11, false, false)
on conflict (key) do update set
  label_sw = excluded.label_sw,
  label_en = excluded.label_en,
  tier_key = excluded.tier_key,
  rank = excluded.rank,
  ministry_required = excluded.ministry_required,
  active = true;
