-- Private, self-reported pending-payment samples. Does not query HESLB or banks.
begin;
insert into public.ministries(name,description)
select 'Wizara ya Mikopo na Uwezeshaji','Ufuatiliaji wa changamoto za mikopo'
where not exists(select 1 from public.ministries where active and (name ilike '%mikopo%' or name ilike '%loans%'))
on conflict(name) do update set active=true;
create table if not exists public.loan_pending_settings(
 id smallint primary key default 1 check(id=1),
 ministry_id uuid not null references public.ministries(id),
 is_open boolean not null default true
);
insert into public.loan_pending_settings(id,ministry_id)
select 1,id from public.ministries where active and(name ilike '%mikopo%' or name ilike '%loans%') order by name limit 1 on conflict(id) do nothing;
create or replace function public.loan_pending_is_super() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and active and role='super_admin');
$$;
create or replace function public.can_manage_loan_pending() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and
 (p.role='super_admin' or(p.role='leader' and p.position='minister' and exists(
 select 1 from public.loan_pending_settings s join public.ministries m on m.id=s.ministry_id
 where s.ministry_id=p.ministry_id and m.active))));
$$;
create table if not exists public.loan_pending_samples(
 id uuid primary key default gen_random_uuid(),
 full_name text not null check(char_length(full_name) between 5 and 120 and full_name ~ '^[^[:space:]]+ [^[:space:]]+ [^[:space:]].*$'),
 registration_number text not null unique check(registration_number ~ '^RU/[A-Z0-9-]+/[0-9]{4}/[0-9]{1,8}$'),
 index_number text not null unique check(index_number ~ '^[SP][0-9]{4}\.[0-9]{4}\.[0-9]{4}$'),
 bank text not null check(bank in('CRDB','TCB','NMB','OTHER')),
 bank_other text check(char_length(bank_other) between 2 and 80),
 account_number text not null check(account_number ~ '^[0-9]{6,30}$'),
 created_at timestamptz not null default now(),
 check((bank='OTHER' and bank_other is not null)or(bank<>'OTHER' and bank_other is null))
);
create index if not exists loan_pending_order on public.loan_pending_samples(created_at desc,id desc);
create table if not exists public.loan_pending_access_log(
 id bigint generated always as identity primary key,
 actor_id uuid not null,
 action text not null check(action in('reveal','export','configure')),
 sample_id uuid,
 row_count integer,
 created_at timestamptz not null default now()
);
alter table public.loan_pending_samples enable row level security;
alter table public.loan_pending_settings enable row level security;
alter table public.loan_pending_access_log enable row level security;
-- No direct table access for visitors or authenticated accounts, even staff.
-- Sensitive values are returned only by guarded RPCs; reveal/export are logged.
revoke all on public.loan_pending_samples,public.loan_pending_settings,public.loan_pending_access_log from public,anon,authenticated;
create or replace function public.loan_pending_public_info() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('is_open',is_open) from public.loan_pending_settings where id=1;
$$;
create or replace function public.submit_loan_pending_sample(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare n text;r text;i text;b text;o text;a text;v_open boolean;
begin
 n:=regexp_replace(btrim(p_payload->>'full_name'),'[[:space:]]+',' ','g');
 r:=upper(regexp_replace(p_payload->>'registration_number','[[:space:]]','','g'));
 i:=upper(regexp_replace(p_payload->>'index_number','[[:space:]]','','g'));
 b:=upper(btrim(p_payload->>'bank'));o:=nullif(btrim(p_payload->>'bank_other'),'');
 a:=regexp_replace(p_payload->>'account_number','[[:space:]]','','g');
 if n is null or char_length(n) not between 5 and 120 or n !~ '^[^[:space:]]+ [^[:space:]]+ [^[:space:]].*$' then raise exception 'INVALID_NAME';end if;
 if r is null or r !~ '^RU/[A-Z0-9-]+/[0-9]{4}/[0-9]{1,8}$' then raise exception 'INVALID_REG';end if;
 if i is null or i !~ '^[SP][0-9]{4}\.[0-9]{4}\.[0-9]{4}$' then raise exception 'INVALID_INDEX';end if;
 if b is null or b not in('CRDB','TCB','NMB','OTHER')or(b='OTHER' and(o is null or char_length(o) not between 2 and 80))then raise exception 'INVALID_BANK';end if;
 if a is null or a !~ '^[0-9]{6,30}$' then raise exception 'INVALID_ACCOUNT';end if;
 if p_payload->>'consent' is distinct from 'true' then raise exception 'CONSENT_REQUIRED';end if;
 -- Serialize intake against closure, deduplication and shared daily cap.
 select is_open into v_open from public.loan_pending_settings where id=1 for update;
 if v_open is distinct from true then raise exception 'REGISTRATION_CLOSED';end if;
 -- Same generic receipt for duplicates: never disclose an existing student's data
 -- and never overwrite bank details through an unauthenticated registration.
 if exists(select 1 from public.loan_pending_samples where registration_number=r or index_number=i)then return jsonb_build_object('received',true);end if;
 if(select count(*)from public.loan_pending_samples where created_at>=date_trunc('day',now() at time zone 'Africa/Dar_es_Salaam')at time zone 'Africa/Dar_es_Salaam')>=500 then raise exception 'DAILY_LIMIT';end if;
 insert into public.loan_pending_samples(full_name,registration_number,index_number,bank,bank_other,account_number)
 values(n,r,i,b,case when b='OTHER' then o else null end,a);
 return jsonb_build_object('received',true);
end;$$;
create or replace function public.list_loan_pending_samples(p_bank text default null,p_offset integer default 0,p_accounts boolean default false)returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_rows jsonb;v_total bigint;
begin
 if not public.can_manage_loan_pending()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if p_offset is null or p_offset<0 or p_accounts is null or(p_bank is not null and p_bank not in('CRDB','TCB','NMB','OTHER'))then raise exception 'INVALID_FILTER';end if;
 select count(*)into v_total from public.loan_pending_samples where p_bank is null or bank=p_bank;
 select coalesce(jsonb_agg(to_jsonb(t)order by t.created_at desc,t.id desc),'[]'::jsonb)into v_rows from(
 select id,full_name,registration_number,index_number,bank,bank_other,
 '••••'||right(account_number,4)as account_masked,
 case when p_accounts then account_number else null end as account_number,created_at
 from public.loan_pending_samples where p_bank is null or bank=p_bank order by created_at desc,id desc limit 100 offset p_offset)t;
 if p_accounts then insert into public.loan_pending_access_log(actor_id,action,row_count)values(auth.uid(),'export',jsonb_array_length(v_rows));end if;
 return jsonb_build_object('total',v_total,'rows',v_rows);
end;$$;
create or replace function public.reveal_loan_pending_account(p_id uuid)returns text
language plpgsql security definer set search_path='' as $$
declare v_account text;
begin
 if not public.can_manage_loan_pending()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 select account_number into v_account from public.loan_pending_samples where id=p_id;
 if v_account is null then raise exception 'NOT_FOUND';end if;
 insert into public.loan_pending_access_log(actor_id,action,sample_id)values(auth.uid(),'reveal',p_id);
 return v_account;
end;$$;
create or replace function public.loan_pending_admin_settings()returns jsonb
language sql stable security definer set search_path='' as $$
 select case when public.loan_pending_is_super()then(select jsonb_build_object('is_open',is_open,'ministry_id',ministry_id)from public.loan_pending_settings where id=1)else null end;
$$;
create or replace function public.configure_loan_pending(p_open boolean,p_ministry uuid)returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.loan_pending_is_super()then raise exception 'NOT_AUTHORIZED'using errcode='42501';end if;
 if p_open is null or not exists(select 1 from public.ministries where id=p_ministry and active and(name ilike '%mikopo%'or name ilike '%loans%'))then raise exception 'INVALID_MINISTRY';end if;
 update public.loan_pending_settings set is_open=p_open,ministry_id=p_ministry where id=1;
 insert into public.loan_pending_access_log(actor_id,action)values(auth.uid(),'configure');
end;$$;
revoke all on function public.loan_pending_is_super(),public.can_manage_loan_pending(),public.loan_pending_public_info(),public.submit_loan_pending_sample(jsonb),public.list_loan_pending_samples(text,integer,boolean),public.reveal_loan_pending_account(uuid),public.loan_pending_admin_settings(),public.configure_loan_pending(boolean,uuid)from public,anon,authenticated;
grant execute on function public.loan_pending_public_info(),public.submit_loan_pending_sample(jsonb)to anon,authenticated;
grant execute on function public.loan_pending_is_super(),public.can_manage_loan_pending(),public.list_loan_pending_samples(text,integer,boolean),public.reveal_loan_pending_account(uuid),public.loan_pending_admin_settings(),public.configure_loan_pending(boolean,uuid)to authenticated;
notify pgrst,'reload schema';
commit;
