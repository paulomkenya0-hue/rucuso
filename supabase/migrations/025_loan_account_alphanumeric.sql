-- Accept bank account identifiers containing letters and digits. Keep as text.
-- Apply after 024; existing reports and access permissions are preserved.
begin;
alter table public.loan_pending_samples drop constraint if exists loan_pending_samples_account_number_check;
alter table public.loan_pending_samples add constraint loan_pending_samples_account_number_check
 check(account_number ~ '^[A-Za-z0-9]{6,30}$');
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
 if a is null or a !~ '^[A-Za-z0-9]{6,30}$' then raise exception 'INVALID_ACCOUNT';end if;
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
revoke all on function public.submit_loan_pending_sample(jsonb) from public,anon,authenticated;
grant execute on function public.submit_loan_pending_sample(jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
