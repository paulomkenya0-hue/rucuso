// Real PostgreSQL-engine regression with fabricated local identities only.
// RUCUSO_PGLITE_PATH=/path/to/@electric-sql/pglite node tests/education-postgres.integration.js
const fs=require('node:fs'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.RUCUSO_PGLITE_PATH||'@electric-sql/pglite');
(async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
   create table public.ministries(id uuid primary key default gen_random_uuid(),name text unique,description text,active boolean default true);
   create table public.profiles(id uuid primary key,full_name text,role text,position text,ministry_id uuid,active boolean default true);
   create table public.parliament_members(id uuid primary key default gen_random_uuid(),full_name text,constituency text,active boolean default true);
  `);
  await db.exec(fs.readFileSync('supabase/migrations/023_education_feedback.sql','utf8'));
  // Re-run must preserve data/permissions and be safe for an operator retry.
  await db.exec(fs.readFileSync('supabase/migrations/023_education_feedback.sql','utf8'));
  const ids={};for(const[n,key]of ['super','minister','deputy','secretary','other','cr','mp','student','admin','president'].entries()){ids[key]='00000000-0000-0000-0000-'+String(n+1).padStart(12,'0');await db.query('insert into auth.users values($1)',[ids[key]]);}
  const ministry=(await db.query('select ministry_id from public.education_settings')).rows[0].ministry_id;
  const other=(await db.query("insert into public.ministries(name)values('Wizara ya Michezo')returning id")).rows[0].id;
  for(const[key,role,position,mid]of [['super','super_admin',null,null],['minister','leader','minister',ministry],['deputy','leader','deputy_minister',ministry],['secretary','leader','ministry_secretary',ministry],['other','leader','minister',other],['admin','admin',null,null],['president','leader','president',null]])await db.query('insert into public.profiles(id,full_name,role,position,ministry_id)values($1,$2,$3,$4,$5)',[ids[key],key+' Actual Name',role,position,mid]);
  const mp=(await db.query("insert into public.parliament_members(full_name,constituency)values('Actual MP Name','Faculty One')returning id")).rows[0].id;
  async function who(key,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[key?ids[key]:'']);await db.exec('set role '+role);}
  let seq=0;function payload(role='student'){seq++;return{sender_role:role,full_name:'Self Declared Name',registration_number:'RU/TEST/2026/'+seq,course:'TEST',study_year:1,phone:'0700000000',role_scope:role==='student'?null:'Claimed scope',kind:'complaint',category:'teaching',title:'Teaching concern '+seq,description:'Local fabricated concern for testing.',solution:'Improve the timetable',evidence_url:''};}
  async function submit(p){return(await db.query('select public.submit_education_feedback($1::jsonb) as receipt',[JSON.stringify(p)])).rows[0].receipt;}
  await who(null,'anon');const spoof=payload('minister');spoof.role_verified=true;spoof.verified_account=ids.super;const receipt=await submit(spoof);assert.equal(receipt.role_verified,false);
  await assert.rejects(db.query('select * from public.education_feedback'),e=>e.code==='42501');
  const track=async token=>(await db.query('select public.track_education_feedback($1,$2)as item',[receipt.reference,token])).rows[0].item;
  assert.equal((await track(receipt.tracking_token)).reference,receipt.reference);assert.equal(await track('ffffffff-ffff-ffff-ffff-ffffffffffff'),null);
  for(const key of ['deputy','secretary','other','cr','mp','student','admin','president']){await who(key);assert.equal((await db.query('select public.can_manage_education()as allowed')).rows[0].allowed,false);assert.equal((await db.query('select * from public.education_feedback')).rows.length,0);await assert.rejects(db.query('select public.list_education_feedback()'),e=>e.code==='42501');await assert.rejects(db.query("select public.reply_education_feedback(gen_random_uuid(),'resolved','Unauthorized reply')"),e=>e.code==='42501');}
  for(const key of ['super','minister']){await who(key);const inbox=(await db.query('select public.list_education_feedback()as data')).rows[0].data;assert.equal(inbox.total,1);assert.equal(inbox.rows[0].role_verified,false);assert(!Object.hasOwn(inbox.rows[0],'tracking_token'));}
  await who('minister');const item=(await db.query('select public.list_education_feedback()as data')).rows[0].data.rows[0];await db.query('select public.reply_education_feedback($1,$2,$3)',[item.id,'in_progress','Local test reply']);await who(null,'anon');assert.equal((await track(receipt.tracking_token)).replies[0].reply,'Local test reply');
  await who('super');await db.query('select public.save_education_representative($1,$2,$3,$4,$5,$6,$7,$8)',[ids.cr,'cr','Verified CR Name','RU/TEST/2026/100','TEST',1,'Class A',null]);await db.query('select public.save_education_representative($1,$2,$3,$4,$5,$6,$7,$8)',[ids.mp,'mp','Ignored fake name',null,null,null,'Fallback scope',mp]);
  await who('cr');const cr=await submit(payload('cr'));assert.equal(cr.role_verified,true);assert.equal((await db.query('select * from public.education_representatives')).rows.length,0);
  await who('mp');assert.equal((await submit(payload('mp'))).role_verified,true);
  await who('other');assert.equal((await submit(payload('minister'))).role_verified,true);assert.equal((await db.query('select public.can_manage_education()as allowed')).rows[0].allowed,false);
  await who('super');const records=(await db.query('select public.list_education_feedback()as data')).rows[0].data.rows;
  assert(records.some(r=>r.sender_role==='cr'&&r.full_name==='Verified CR Name'&&r.role_scope==='Class A'));
  assert(records.some(r=>r.sender_role==='mp'&&r.full_name==='Actual MP Name'&&r.role_scope==='Faculty One'));
  assert(records.some(r=>r.sender_role==='minister'&&r.role_verified&&r.full_name==='other Actual Name'&&r.role_scope==='Wizara ya Michezo'));
  await db.query('select public.set_education_representative_active($1,$2,$3)',[ids.cr,'cr',false]);await who('cr');assert.equal((await submit(payload('cr'))).role_verified,false);
  await assert.rejects(db.query('select public.save_education_representative($1,$2,$3,$4,$5,$6,$7,$8)',[ids.student,'cr','Forged CR',null,null,null,'Class A',null]),e=>e.code==='42501');
  await who('super');await db.query('select public.configure_education($1,$2,$3)',['Local education',false,ministry]);await who(null,'anon');await assert.rejects(submit(payload()),e=>e.message==='EDUCATION_CLOSED');
  console.log('PostgreSQL: private RLS and RPC permissions, minister-only routing, forged roles denied verification, CR/MP account links, minister identity, secret tracking, replies, deactivation and closure passed.');
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exit(1);});
