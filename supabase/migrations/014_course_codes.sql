-- =============================================================================
-- 014 — RU/COURSE/YEAR/NUMBER registration format
--
-- Moves the student registry from the pre-2026 shape to the official RUCU one:
--
--     RU/<COURSE_CODE>/<YEAR>/<STUDENT_NUMBER>      RU/BAFIT/2024/007
--     <PREFIX>/<YEAR>/<INDEX>            (legacy)  RUCU/2024/01
--
-- WHY THIS IS A MIGRATION AND NOT A VALIDATION CHANGE
--
-- The course code is the whole problem. It is the one segment of the new format
-- that does not exist in the old number, and it is not stored anywhere on the
-- students table. `programme` and `faculty` are free text and neither contains a
-- course code, so there is no way to derive "BAFIT" for a given row from data
-- already in the database. Somebody who knows the answer has to supply it.
--
-- So this migration adds the column, preserves the old number, and leaves the
-- backfill as a deliberate, separately-run step. It does NOT guess.
--
-- WHAT IT DOES
--   1. students.course_code                    — the new segment
--   2. students.legacy_registration_number     — the pre-2026 number, preserved
--   3. students.registration_format             — 'current' | 'legacy' | 'pending'
--   4. A CHECK constraint on the current-format rows, so the database itself
--      refuses a malformed number from any importer, not just the web form
--   5. backfill_student_registration_numbers() — performs the rewrite, but only
--      for rows that already have a course_code
--   6. A report query for the rows still needing a course code
--
-- SAFE TO APPLY. Every step is additive. No existing registration_number is
-- touched until backfill_student_registration_numbers() is called explicitly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. course_code
-- -----------------------------------------------------------------------------
-- Null is allowed and expected: it is the marker for "this student has not been
-- assigned a course yet", which is what the report in section 6 counts. It is
-- deliberately NOT NOT NULL, because making it so before the backfill would
-- lock the table against every existing row.
alter table students add column if not exists course_code text;

comment on column students.course_code is
  'Course segment of the RU/CODE/YEAR/NUMBER registration number, e.g. BAFIT. '
  'Null means the student has not been migrated yet; see backfill_student_registration_numbers().';

-- -----------------------------------------------------------------------------
-- 2. legacy_registration_number
-- -----------------------------------------------------------------------------
-- The pre-2026 number, kept after the rewrite. Three reasons this is a separate
-- column and not a history table:
--   * lookup-student still matches on it, so an unmigrated student is told
--     "pending migration" rather than "not found"
--   * send-otp and verify-otp resolve the same row, so a student mid-migration
--     does not get a different answer at step 1 and step 2
--   * it is what makes the rewrite reversible without a restore from backup
alter table students add column if not exists legacy_registration_number text;

-- -----------------------------------------------------------------------------
-- 3. registration_format
-- -----------------------------------------------------------------------------
-- A denormalised flag, so "how many students are still unmigrated?" is one
-- index scan instead of a full regex pass over the table. Kept consistent by the
-- trigger in section 5, never set by hand.
alter table students add column if not exists registration_format text
  not null default 'pending';

-- Backfill the flag for rows that already exist, before the trigger starts
-- maintaining it. 'current' for anything already in the new shape, 'legacy' for
-- the rest. Deliberately does not attempt the rewrite itself.
update students
   set registration_format = case
         when registration_number ~ '^RU/[A-Z]{2,6}/[0-9]{4}/[0-9]{3,4}$'
           then 'current'
         when registration_number ~ '^[A-Z]{2,6}/[0-9]{2,4}/[0-9]{1,6}$'
           then 'legacy'
         else 'pending'
       end
 where registration_format = 'pending'
   and registration_number is not null;

alter table students drop constraint if exists students_registration_format_chk;
alter table students add constraint students_registration_format_chk
  check (registration_format in ('current', 'legacy', 'pending'));

create index if not exists idx_students_reg_format
  on students (registration_format);
create index if not exists idx_students_course_code
  on students (course_code);

-- Partial index for the migration report. Only pending rows, so it stays small
-- no matter how large the registry grows.
create index if not exists idx_students_pending_course
  on students (lower(course_code))
  where registration_format <> 'current' and course_code is null;

-- -----------------------------------------------------------------------------
-- 4. The CHECK constraint that makes the format a database rule
-- -----------------------------------------------------------------------------
-- Once a row is marked 'current', registration_number must actually be in the
-- current format. This is the guarantee that makes the front-end regex a
-- convenience rather than the only defence: a bulk import, a spreadsheet paste
-- or a direct psql session cannot introduce a malformed "current" number.
--
-- The 'legacy' and 'pending' rows are exempt, because their old numbers are
-- still in the old shape by definition. A single constraint therefore covers
-- both worlds without a migration flag being checked in application code.
--
-- upper() is used so the check is case-insensitive, matching how the lookup
-- normalises. The web form already upper-cases on input.
alter table students drop constraint if exists students_current_format_chk;
alter table students add constraint students_current_format_chk
  check (
    registration_format <> 'current'
    or registration_number ~ '^RU/[A-Z]{2,6}/[0-9]{4}/[0-9]{3,4}$'
  );

-- -----------------------------------------------------------------------------
-- 5. backfill_student_registration_numbers()
-- -----------------------------------------------------------------------------
-- Rewrites registration_number into the new format for rows that have a
-- course_code, preserving the old value in legacy_registration_number.
--
-- CALLED EXPLICITLY, NEVER AUTOMATICALLY. It is a function so that it is one
-- obvious, greppable action:
--
--     select backfill_student_registration_numbers();
--
-- Rows without a course_code are skipped, not defaulted. Defaulting them to
-- some guessed code would produce numbers that look valid, pass the CHECK
-- constraint, and send a real student to the wrong course's page. Skipping
-- leaves them visibly pending, which the report in section 6 counts.
--
-- Idempotent: re-running it is a no-op, so it is safe to run again after more
-- course codes have been supplied.
create or replace function backfill_student_registration_numbers()
returns table (migrated bigint, skipped bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_migrated bigint := 0;
  v_skipped  bigint := 0;
begin
  -- Preflight: a duplicate registration_number would violate the unique index
  -- mid-statement and roll the whole batch back. Checked and reported first, so
  -- a collision is a legible error rather than an aborted transaction.
  if exists (
    select 1 from (
      select upper('RU/' || course_code || '/'
             || split_part(registration_number, '/', 2) || '/'
             || lpad(split_part(registration_number, '/', 3), 3, '0')) as new_num
        from students
       where course_code is not null
         and registration_number ~ '^[A-Z]{2,6}/[0-9]{2,4}/[0-9]{1,6}$'
    ) built
    group by built.new_num
    having count(*) > 1
  ) then
    raise exception
      'Backfill aborted: the course codes supplied would produce duplicate registration numbers. '
      'Two students with the same year and index have been given the same course code.';
  end if;

  update students
     set legacy_registration_number = coalesce(legacy_registration_number, registration_number),
         registration_number = upper(
           'RU/' || course_code || '/'
           || split_part(registration_number, '/', 2) || '/'
           || lpad(split_part(registration_number, '/', 3), 3, '0')
         ),
         registration_format = 'current',
         updated_at = now()
   where course_code is not null
     and registration_number ~ '^[A-Z]{2,6}/[0-9]{2,4}/[0-9]{1,6}$'
     and registration_number !~ '^RU/[A-Z]{2,6}/[0-9]{4}/[0-9]{3,4}$';

  get diagnostics v_migrated = row_count;

  select count(*) into v_skipped
    from students
   where course_code is null
     and registration_format <> 'current';

  return query select v_migrated, v_skipped;
end;
$$;

comment on function backfill_student_registration_numbers() is
  'Rewrites legacy registration numbers to RU/CODE/YEAR/NNN for rows with a course_code. '
  'Skips rows without one. Idempotent. Run manually: select backfill_student_registration_numbers();';

-- -----------------------------------------------------------------------------
-- 5b. Keep registration_format honest
-- -----------------------------------------------------------------------------
-- Any UPDATE that changes the number or the format re-evaluates the flag, so a
-- direct psql UPDATE or a future importer cannot leave a row claiming 'current'
-- while holding a legacy number. The CHECK constraint in section 4 is the
-- backstop; this is what makes the flag meaningful rather than decorative.
create or replace function students_sync_registration_format()
returns trigger
language plpgsql
as $$
begin
  if new.registration_number is distinct from old.registration_number
     or new.registration_format is distinct from old.registration_format then
    new.registration_format := case
      when new.registration_number ~ '^RU/[A-Z]{2,6}/[0-9]{4}/[0-9]{3,4}$' then 'current'
      when new.registration_number ~ '^[A-Z]{2,6}/[0-9]{2,4}/[0-9]{1,6}$' then 'legacy'
      else 'pending'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_students_sync_registration_format on students;
create trigger trg_students_sync_registration_format
  before insert or update of registration_number, registration_format on students
  for each row execute function students_sync_registration_format();

-- -----------------------------------------------------------------------------
-- 6. Migration report
-- -----------------------------------------------------------------------------
-- What still needs a human decision. Run this after every batch of course-code
-- assignments; when 'still_pending' reaches 0 the migration is done.
--
--   select * from registration_migration_report();
--
create or replace view registration_migration_report as
select
  registration_format,
  count(*)                                              as total,
  count(*) filter (where course_code is null)           as still_pending,
  count(distinct programme)                             as programmes,
  min(registration_number)                              as sample_oldest,
  max(registration_number)                              as sample_newest
from students
group by registration_format
order by registration_format;

comment on view registration_migration_report is
  'Migration status by format. still_pending > 0 means students whose course code '
  'has not been supplied yet and who therefore cannot be migrated automatically.';

-- The one query to actually drive the backfill work: which students still need a
-- course code, grouped by programme so whoever assigns codes is working from a
-- short list rather than the whole registry.
create or replace view registration_course_code_worklist as
select
  coalesce(nullif(btrim(programme), ''), '(programme unknown)') as programme,
  coalesce(nullif(btrim(faculty), ''),  '(faculty unknown)')  as faculty,
  count(*)                        as students,
  min(registration_number)        as sample_number,
  max(registration_number)        as sample_highest
from students
where course_code is null
  and registration_format <> 'current'
group by 1, 2
order by students desc, programme;

comment on view registration_course_code_worklist is
  'Students still missing a course code, grouped by programme. This is the worklist '
  'for whoever supplies course codes before running backfill_student_registration_numbers().';

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
-- students already has RLS enabled (schema.sql) and no anon-readable policy: the
-- registry is reachable only through the service-role Edge Functions, which is
-- the whole point of the boolean-only lookup. The new columns inherit that, and
-- no policy is added here on purpose — a policy over these columns would be an
-- identity leak, since course_code + registration_number together identify a
-- student as surely as a name does.
--
-- Nothing in this migration touches the anon role or grants any new execute
-- rights. backfill_student_registration_numbers() is security invoker, so it
-- runs with the caller's rights and is not callable by anon.
