// Fabricated local identities only; never contacts the production database.
// RUCUSO_PGLITE_PATH=/path/to/@electric-sql/pglite node tests/loan-pending-postgres.integration.js
const fs=require('node:fs'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.RUCUSO_PGLITE_PATH||'@electric-sql/pglite');
(async()=>{const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
 create table public.ministries(id uuid primary key default gen_random_uuid(),name text unique,description text,active boolean default true);
 create table public.profiles(id uuid primary key,full_name text,role text,position text,ministry_id uuid,active boolean default true);`);
 const sql=fs.readFileSync('supabase/migrations/024_loan_pending_samples.sql','utf8');await db.exec(sql);await db.exec(sql);
 const ministry=(await db.query('select ministry_id from public.loan_pending_settings')).rows[0].ministry_id;
 const other=(await db.query("insert into public.ministries(name)values('Wizara ya Elimu')returning id")).rows[0].id;
 const ids={};let seq=0;
 for(const[key,role,pos,mid,active]of [['super','super_admin',null,null,true],['minister','leader','minister',ministry,true],['deputy','leader','deputy_minister',ministry,true],['secretary','leader','ministry_secretary',ministry,true],['other','leader','minister',other,true],['admin','admin',null,ministry,true],['president','leader','president',null,true],['student','student',null,null,true],['inactive','leader','minister',ministry,false]]){ids[key]='00000000-0000-0000-0000-'+String(++seq).padStart(12,'0');await db.query('insert into profiles values($1,$2,$3,$4,$5,$6)',[ids[key],key,role,pos,mid,active]);}
 async function who(key,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[key]||'']);await db.exec('set role '+role);}
 const payload={full_name:'Sample Student Name',registration_number:' ru / bafit /2024/007 ',index_number:' s1234.0001.2024 ',bank:'CRDB',account_number:'0152000000123',consent:true};
 const submit=async p=>(await db.query('select public.submit_loan_pending_sample($1::jsonb)as receipt',[JSON.stringify(p)])).rows[0].receipt;
 const list=async(bank=null,off=0,accounts=false)=>(await db.query('select public.list_loan_pending_samples($1,$2,$3)as data',[bank,off,accounts])).rows[0].data;
 await who(null,'anon');assert.equal((await submit(payload)).received,true);
 for(const[field,value,pattern]of [['full_name','Two Names',/INVALID_NAME/],['registration_number','NO123',/INVALID_REG/],['index_number','S/P1234.0001.2024',/INVALID_INDEX/],['account_number','1234',/INVALID_ACCOUNT/],['account_number','0123456789X',/INVALID_ACCOUNT/],['bank','FAKE',/INVALID_BANK/],['consent',false,/CONSENT_REQUIRED/]])await assert.rejects(submit({...payload,[field]:value}),pattern);
 // Anonymous duplicates receive a generic acknowledgment, without overwrite or PII.
 const duplicate=await submit({...payload,account_number:'9999999999999'});assert.deepEqual(duplicate,{received:true});
 const otherSample={...payload,registration_number:'RU/BAFIT/2024/008',index_number:'P1234.0002.2024',bank:'OTHER',bank_other:'Sample Bank',account_number:'000000001234'};await submit(otherSample);
 await assert.rejects(submit({...otherSample,bank_other:''}),/INVALID_BANK/);
 await assert.rejects(db.query('select * from public.loan_pending_samples'),e=>e.code==='42501');
 await assert.rejects(list(),e=>e.code==='42501');
 await assert.rejects(db.query("insert into public.loan_pending_samples(full_name)values('Unauthorised')"),e=>e.code==='42501');
 for(const key of ['deputy','secretary','other','admin','president','student','inactive']){await who(key);assert.equal((await db.query('select public.can_manage_loan_pending()as ok')).rows[0].ok,false);await assert.rejects(list(),e=>e.code==='42501');await assert.rejects(db.query('select public.reveal_loan_pending_account(gen_random_uuid())'),e=>e.code==='42501');await assert.rejects(db.query('select * from public.loan_pending_samples'),e=>e.code==='42501');await assert.rejects(db.query('select public.configure_loan_pending(true,$1)',[ministry]),e=>e.code==='42501');assert.equal((await db.query('select public.loan_pending_admin_settings()as s')).rows[0].s,null);}
 for(const key of ['minister','super']){await who(key);const rows=await list();assert.equal(rows.total,2);assert(rows.rows.every(r=>r.account_number===null&&!Object.hasOwn(r,'tracking_token')));const r=(await list('CRDB')).rows[0];assert.equal(r.registration_number,'RU/BAFIT/2024/007');assert.equal(r.index_number,'S1234.0001.2024');assert.equal(r.account_masked,'••••0123');assert.equal((await db.query('select public.reveal_loan_pending_account($1)as account',[r.id])).rows[0].account,'0152000000123');assert.equal((await list('CRDB',0,true)).rows[0].account_number,'0152000000123');await assert.rejects(db.query('select * from public.loan_pending_samples'),e=>e.code==='42501');}
 await who('minister');await assert.rejects(db.query('select public.configure_loan_pending(false,$1)',[ministry]),e=>e.code==='42501');
 await who('super');await assert.rejects(db.query('select public.configure_loan_pending(true,$1)',[other]),/INVALID_MINISTRY/);await db.query('select public.configure_loan_pending(false,$1)',[ministry]);
 await who(null,'anon');assert.equal((await db.query('select public.loan_pending_public_info()as i')).rows[0].i.is_open,false);await assert.rejects(submit(otherSample),/REGISTRATION_CLOSED/);
 await who(null);await db.exec('reset role');const logs=(await db.query('select action,count(*)::int as n from loan_pending_access_log group by action')).rows;assert(logs.some(r=>r.action==='reveal'&&r.n===2));assert(logs.some(r=>r.action==='export'&&r.n===2));assert.equal((await db.query('select count(*)::int as n from loan_pending_samples')).rows[0].n,2);
 // More than one page; no masked or truncated data in a full export.
 for(let i=10;i<115;i++)await db.query('insert into loan_pending_samples(full_name,registration_number,index_number,bank,account_number)values($1,$2,$3,$4,$5)',['Test Sample Student','RU/TEST/2024/'+i,'S1234.'+String(i).padStart(4,'0')+'.2024','TCB','000000123456']);
 await who('minister');const page1=await list('TCB',0,true),page2=await list('TCB',100,true);assert.equal(page1.total,105);assert.equal(page1.rows.length,100);assert.equal(page2.rows.length,5);assert.equal(new Set([...page1.rows,...page2.rows].map(r=>r.id)).size,105);
 await who(null);await db.exec('reset role');await db.query('update ministries set active=false where id=$1',[ministry]);await who('minister');assert.equal((await db.query('select public.can_manage_loan_pending()as ok')).rows[0].ok,false);
 console.log('PostgreSQL passed: anonymous intake, S/P formats, account zeros, validation, duplicate protection, private tables/RPCs, exact minister/super access, masking/reveal audit, multi-page exports, closure and repeatable migration.');
 }finally{await db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
