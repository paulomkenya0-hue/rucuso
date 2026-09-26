-- HESLB permission normalization and authorized year aggregates.
-- Migration 008 already explicitly allows Super Admin; this migration keeps
-- that unconditional branch while covering supported ministry name variants.

create or replace function public.is_heslb_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and (
        p.role = 'super_admin'
        or (
          p.role in ('leader', 'admin')
          and (p.role = 'leader' or coalesce((p.permissions ->> 'manage_heslb_beneficiaries')::boolean, false))
          and exists (
            select 1
            from public.ministries m
            where m.id = p.ministry_id
              and m.active = true
              and regexp_replace(lower(btrim(m.name)), '[^a-z0-9]', '', 'g') in (
                'loansandempowerment',
                'loansempowerment',
                'ministryofloansandempowerment',
                'ministryofloansempowerment',
                'mikoponauwezeshaji',
                'wizarayamikoponauwezeshaji'
              )
          )
        )
      )
  );
$$;

revoke all on function public.is_heslb_manager() from public, anon;
grant execute on function public.is_heslb_manager() to authenticated;

create or replace function public.heslb_beneficiary_year_stats()
returns table (year_of_study smallint, total bigint, active bigint, inactive bigint, graduated bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_heslb_manager() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
    select b.year_of_study,
           count(*)::bigint,
           count(*) filter (where b.status = 'active')::bigint,
           count(*) filter (where b.status = 'inactive')::bigint,
           count(*) filter (where b.status = 'graduated')::bigint
    from public.heslb_beneficiaries b
    group by b.year_of_study
    order by b.year_of_study;
end;
$$;

revoke all on function public.heslb_beneficiary_year_stats() from public, anon;
grant execute on function public.heslb_beneficiary_year_stats() to authenticated;
