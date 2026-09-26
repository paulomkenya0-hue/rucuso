-- ============================================================
-- 011: Server-side pagination support for /admin/students/
--
-- Context: the students management page used to load every row in the
-- table into the browser with a single `.limit(5000)` query and then
-- searched/filtered/counted it in JavaScript. PostgREST caps the number
-- of rows any single request can return (the project's "Max Rows"
-- setting, default 1000) regardless of the client-side `.limit()`, so
-- once the table passed 1000 students:
--   * the on-page total was really `rows.length` of a silently
--     truncated result set, not a real COUNT(*);
--   * search/filter only ever matched inside that first truncated page
--     (ordered by registration_number), so anything alphabetically
--     past it could never be found — "Hakuna mwanafunzi anayelingana".
--
-- The fix (see supabase-client.js / js/data.js / admin/students/) moves
-- search, filtering, counting and pagination onto the database via
-- .range() + { count: 'exact' }. This migration adds the one piece that
-- can't be expressed as an ordinary filtered select: the distinct list
-- of Programme/Faculty/Year values used to populate the filter
-- dropdowns, which must be computed over the *whole* table, not one
-- page of it.
-- ============================================================

create or replace function public.student_filter_options()
returns table (programmes text[], faculties text[], years text[])
language sql
stable
security definer
set search_path = public
as $$
  select
    case when public.is_super_admin() or public.has_permission('manage_students')
      then (select array_agg(distinct programme order by programme) from students where programme is not null)
      else null end,
    case when public.is_super_admin() or public.has_permission('manage_students')
      then (select array_agg(distinct faculty order by faculty) from students where faculty is not null)
      else null end,
    case when public.is_super_admin() or public.has_permission('manage_students')
      then (select array_agg(distinct year_of_study order by year_of_study) from students where year_of_study is not null)
      else null end;
$$;

grant execute on function public.student_filter_options() to authenticated;

-- Indexes to keep the new server-side search/filter/pagination queries
-- fast at any table size (idx_students_reg from schema.sql already
-- covers the registration-number half of the search).
create index if not exists idx_students_full_name on students (lower(full_name));
create index if not exists idx_students_programme on students (programme);
create index if not exists idx_students_faculty on students (faculty);
create index if not exists idx_students_year on students (year_of_study);
create index if not exists idx_students_status on students (student_status);