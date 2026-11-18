const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const common=fs.readFileSync('js/community-common.js','utf8');
const publicCode=fs.readFileSync('js/community.js','utf8');
const staffCode=fs.readFileSync('js/student-services-staff.js','utf8');
const sql=fs.readFileSync('supabase/migrations/020_student_community.sql','utf8');
class Node {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.events={};this.value='';this.hidden=false;this.dataset={};this.attrs={};this.scrollTop=0;this.scrollHeight=100;this.clientHeight=100;}
  append(...nodes){this.children.push(...nodes);nodes.forEach(n=>n.parent=this);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  addEventListener(name,fn){this.events[name]=fn;}
  setAttribute(k,v){this.attrs[k]=v;}
  closest(){return this.label ||= new Node('label');}
  querySelector(q){if(q==='[value="first_year_feedback"]'||q==='[value="security"]')return new Node('option');return this.children.find(n=>n.tagName==='BUTTON') || (this.submit ||=new Node('button'));}
  querySelectorAll(){return [this.querySelector('button')];}
  reportValidity(){return true;}
  remove(){this.removed=true;}
  scrollIntoView(){this.scrolled=true;}
  reset(){this.didReset=true;}
}
const flush=()=>new Promise(r=>setImmediate(r));
async function setup({staff=false,member=null,permissions={},profile={role:'leader',full_name:'Leader'},failCases=false}={}) {
  const nodes={},calls=[],timers=[];let rows=[],rpcReply=null,rpcError=null,oauthError=null;
  const $=id=>nodes[id]||=new Node();
  const fields={
    'security-form':{kind:'lost',full_name:'Student Example',programme:'BAFIT',study_year:'2',phone:'0712345678',title:'Funguo',description:'Nimepoteza funguo za chumba.',incident_date:'2026-11-17',incident_location:'Maktaba',residence_type:'campus_boys',hostel:'Nkembo',residence_detail:''},
    'first-year-form':{kind:'first_year_feedback',full_name:'First Year',programme:'BAFIT',study_year:'1',phone:'0712345678',title:'Pendekezo',description:'Naomba huduma za kujisomea ziongezwe.'},
    'tracking-form':{reference:'RUC-EXAMPLE',token:'12345678-1234-1234-1234-123456789abc'},
    'chat-join':{display_name:'Student Example',programme:'BAFIT',study_year:'1',registration_number:''},
    'chat-send':{body:''}
  };
  for(const [id,values]of Object.entries(fields)){$(id).elements={};for(const[k,v]of Object.entries(values)){$(id).elements[k]=new Node('input');$(id).elements[k].value=v;}}
  $('case-kind').value='security';$('member-state').value='pending';
  const client={
    auth:{getSession:async()=>({data:{session:member?{user:{id:'member-id',user_metadata:{full_name:'Google Student'}}}:null}}),signOut:async()=>{},signInWithOAuth:async(args)=>{calls.push({name:'oauth',args});return{data:{url:'https://accounts.google.com/'},error:oauthError};}},
    from(table){calls.push({table});const q={then(resolve){resolve({data:rows,error:failCases&&table==='student_cases'?{message:'Case service unavailable'}:null,count:rows.length});},maybeSingle:async()=>({data:member,error:null})};for(const n of ['select','eq','order','range','in','limit'])q[n]=(...args)=>{calls.push({table,method:n,args});return q;};return q;},
    rpc:async(name,args)=>{calls.push({name,args});if(rpcError)throw rpcError;
      if(name.startsWith('can_'))return{data:!!permissions[name],error:null};
      if(name==='read_community_messages')return{data:rows,error:null};
      if(name==='submit_student_case')return{data:{reference:'RUC-TEST',tracking_token:'12345678-1234-1234-1234-123456789abc',response_due_at:'2026-11-18T12:00:00Z'},error:null};
      if(name==='track_student_case')return{data:rpcReply,error:null};
      return{data:null,error:null};}
  };
  const document={hidden:false,getElementById:$,createElement:tag=>new Node(tag)};
  const window={RucusoAPI:{client},RucusoGuard:{requireRole:async()=>({profile}),logout:async()=>{}},addEventListener(){}};
  const storage=new Map();
  const sessionStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const ctx={window,document,sessionStorage,URL,Date,Intl,Map,Set,Number,String,encodeURIComponent,console,location:{origin:'https://rucuso.online'},alert(){},prompt:()=>null,setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){}};
  vm.runInNewContext(common,ctx);
  const s={$,calls,timers,run(){vm.runInNewContext(staff?staffCode:publicCode,ctx);},setRows(r){rows=r;},setReply(r){rpcReply=r;},setError(e){rpcError=e;},setAuthError(e){oauthError=e;},storage};
  return s;
}
(async()=>{
  for(const [htmlFile,source]of [['community/index.html',publicCode],['staff/student-services/index.html',staffCode]]) {
    const html=fs.readFileSync(htmlFile,'utf8');
    const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);
    assert.equal(new Set(ids).size,ids.length,'HTML IDs must be unique');
    for(const match of source.matchAll(/\$\('([^']+)'\)/g))assert(ids.includes(match[1]),htmlFile+' missing '+match[1]);
  }
  const p=await setup();p.run();await flush();
  const markup=fs.readFileSync('community/index.html','utf8');
  assert(markup.includes('Endelea na Google'));
  assert(!markup.includes('name="password"'));
  assert(!publicCode.includes('signInWithPassword'));
  assert(!publicCode.includes('auth.signUp'));
  await p.$('chat-google').events.click();
  const oauth=p.calls.find(c=>c.name==='oauth');
  assert.equal(oauth.args.provider,'google');
  assert.equal(oauth.args.options.redirectTo,'https://rucuso.online/community/');
  assert.equal(oauth.args.options.queryParams.prompt,'select_account');
  assert.equal(p.storage.get('rucuso_chat_google_return'),'1');
  p.setAuthError(new Error('Unsupported provider'));
  await p.$('chat-google').events.click();
  assert.equal(p.$('chat-google').disabled,false);
  assert.equal(p.storage.has('rucuso_chat_google_return'),false);
  assert.match(p.$('chat-status').textContent,/Google login bado/);
  const returning=await setup({member:{status:'pending'}});
  returning.storage.set('rucuso_chat_google_return','1');returning.run();await flush();
  assert.equal(returning.$('chat').scrolled,true);
  assert.equal(returning.storage.has('rucuso_chat_google_return'),false);

  assert.deepEqual(p.$('security-form').elements.hostel.children.map(n=>n.value),['Nkembo','Katikaza']);
  const f=p.$('security-form');f.elements.residence_type.value='campus_girls';f.elements.residence_type.events.change();
  assert.deepEqual(f.elements.hostel.children.map(n=>n.value),['NMB line','Kamzora','Sisters','Elizabeth']);
  f.elements.residence_type.value='lugalo';f.elements.residence_type.events.change();assert.equal(f.elements.hostel.children[0].value,'Lugalo');
  f.elements.residence_type.value='offcampus';f.elements.residence_type.events.change();assert.equal(f.elements.residence_detail.required,true);assert.equal(p.$('hostel-label').hidden,true);
  f.elements.residence_detail.value='Mtaa wa mfano';await f.events.submit({preventDefault(){}});
  const intake=p.calls.find(c=>c.name==='submit_student_case').args.p_payload;
  assert.equal(intake.residence_name,'Mtaa wa mfano');assert.equal(intake.ministry_id,undefined,'browser must not choose receiving ministry');assert.equal(intake.status,undefined);
  assert(p.$('security-result').children.some(n=>n.textContent==='12345678-1234-1234-1234-123456789abc'));
  p.$('feedback-year').value='1';p.$('feedback-year').events.change();assert.equal(p.$('first-year-form').hidden,false);assert.equal(p.$('continuing-feedback').hidden,true);
  for(const y of ['2','3','4']){p.$('feedback-year').value=y;p.$('feedback-year').events.change();assert.equal(p.$('first-year-form').hidden,true);assert.equal(p.$('verified-feedback-link').href,'/?feedback_year='+y+'#submit');}
  await p.$('first-year-form').events.submit({preventDefault(){}});
  const first=p.calls.filter(c=>c.name==='submit_student_case').at(-1).args.p_payload;assert.equal(first.study_year,1);assert.equal(first.kind,'first_year_feedback');assert.equal(first.student_id,undefined);
  p.setReply(null);await p.$('tracking-form').events.submit({preventDefault(){},currentTarget:p.$('tracking-form')});assert.match(p.$('tracking-result').textContent,/Hakuna ripoti/);
  const track=p.calls.find(c=>c.name==='track_student_case');assert.equal(track.args.p_token,'12345678-1234-1234-1234-123456789abc');
  const pending=await setup({member:{status:'pending'}});pending.run();await flush();assert.equal(pending.$('chat-room').hidden,true);assert(!pending.calls.some(c=>c.name==='read_community_messages'));
  const approved=await setup({member:{status:'approved'}});approved.setRows([{id:1,display_name:'<img>',body:'<script>alert(1)</script>',created_at:'2026-11-17T12:00:00Z',is_mine:false}]);approved.run();await flush();
  assert.equal(approved.$('chat-room').hidden,false);assert.equal(approved.$('chat-messages').children[0].children[1].textContent,'<script>alert(1)</script>');
  approved.setError(new Error('NOT_AUTHORIZED'));approved.timers[0]();await flush();assert.equal(approved.$('chat-room').hidden,true);assert.equal(approved.$('chat-messages').children.length,0);
  const denied=await setup({staff:true});denied.run();await flush();assert(!denied.calls.some(c=>c.table==='student_cases'),'unauthorized staff must not load cases');
  const security=await setup({staff:true,permissions:{can_manage_security_cases:true}});security.setRows([{id:'c1',kind:'lost',status:'submitted',title:'Funguo',description:'Case details',full_name:'Student',programme:'BAFIT',study_year:2,created_at:'2026-11-17T10:00:00Z',response_due_at:'2026-11-18T10:00:00Z'}]);security.run();await flush();
  assert.equal(security.$('case-list').children.length,1);const caseForm=security.$('case-list').children[0].children.at(-1);caseForm.children[0].value='in_progress';caseForm.children[1].value='Tunafuatilia.';await caseForm.events.submit({preventDefault(){}});assert(security.calls.some(c=>c.name==='update_student_case'&&c.args.p_status==='in_progress'));
  const app=fs.readFileSync('js/app.js','utf8');
  const nav=app.match(/const PUBLIC_NAV = (\[[\s\S]*?\n\]);/)[1];
  const entries=vm.runInNewContext(nav);
  assert(entries.some(x=>x[0]==='sec-community'));
  const independent=await setup({staff:true,permissions:{can_manage_security_cases:true,can_moderate_community:true},failCases:true});independent.run();await flush();assert.equal(independent.$('membership-panel').hidden,false,'case failure must not hide chat applications');assert(independent.calls.some(c=>c.table==='community_members'));
  assert(!/innerHTML/.test(publicCode+staffCode));
  assert(sql.includes("p.position in ('minister','deputy_minister','ministry_secretary')"));
  assert(sql.includes('s.security_ministry_id=p.ministry_id'));
  assert(sql.includes('c.reference=p_reference and c.tracking_token=p_token'));
  assert(sql.includes("check(kind<>'first_year_feedback' or study_year=1)"));
  assert(sql.includes("interval '24 hours'"));assert(!/status\s*=\s*'resolved'.*24/.test(sql));
  assert(sql.includes('grant select on public.student_cases to authenticated'));
  assert(!/grant select on public.student_cases to anon/.test(sql));
  assert(!/grant (?:insert|update).*community_members/.test(sql));
  const read=sql.split('function public.read_community_messages')[1].split('end; $$;')[0];assert(!read.includes('registration_number'));assert(!read.includes('phone'));assert(read.includes('public.is_community_member() or public.can_moderate_community()'));
  assert.equal((sql.match(/reason text not null/g)||[]).length,1);
  console.log('Community: hostels, private intake, year gates, token tracking, pending/approved/suspended chat, safe text, staff response and SQL privacy contracts passed');
})().catch(e=>{console.error(e);process.exit(1);});
