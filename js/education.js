(function(){
 'use strict';
 const {$,el,rpc,date}=window.RucusoCommunity;
 const {roles,reg,uuid,safeUrl,error}=window.RucusoEducation;
 const form=$('education-form'),client=window.RucusoAPI?.client;
 let identity={roles:[]},open=false;
 function roleNote(){
  const role=form.elements.sender_role.value,hasScope=role!=='student';
  $('education-scope-label').hidden=!hasScope;form.elements.role_scope.required=hasScope;form.elements.role_scope.disabled=!hasScope;
  $('education-scope-title').textContent=role==='cr'?'Darasa / course unayowakilisha':role==='mp'?'Eneo / kitivo unachowakilisha':'Wizara yako';
  $('education-role-note').textContent=role==='student'?'Taarifa za mwanafunzi zinajazwa na wewe.':identity.roles.includes(role)?`${roles[role]} — cheo cha akaunti kimeunganishwa na rekodi iliyohakikiwa. Mfumo utakihakiki tena unapowasilisha.`:`Umejitambulisha kama ${roles[role]}. Cheo hiki bado hakijathibitishwa; kitafika kikiwa na alama hiyo.`;
 }
 async function refreshIdentity(){
  identity=await rpc('education_identity',{});identity.roles=identity.roles||[];
  $('education-google').hidden=!!identity.account_id;
  $('education-identity').textContent=identity.account_id?'Account ID yako: '+identity.account_id+(identity.roles.length?' · Vyeo vilivyounganishwa: '+identity.roles.map(r=>roles[r]).join(', '):' · Hakuna cheo kilichounganishwa bado.'):'Bado hujaingia kwa akaunti. Unaweza kuwasilisha taarifa iliyo hapa chini bila kuingia.';
  roleNote();
 }
 $('education-google').addEventListener('click',async()=>{
  const b=$('education-google');if(!client)return;b.disabled=true;
  try{const r=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+'/education/',queryParams:{prompt:'select_account'}}});if(r.error)throw r.error;}
  catch(e){$('education-identity').textContent=error(e);b.disabled=false;}
 });
 form.elements.sender_role.addEventListener('change',roleNote);roleNote();
 form.addEventListener('submit',async ev=>{
  ev.preventDefault();if(!open||!form.reportValidity())return;
  const out=$('education-receipt'),p={};
  for(const k of ['sender_role','full_name','registration_number','course','study_year','phone','kind','category','title','description','solution','evidence_url'])p[k]=form.elements[k].value.trim();
  p.role_scope=p.sender_role==='student'?null:form.elements.role_scope.value.trim();p.registration_number=reg(p.registration_number);p.study_year=Number(p.study_year);p.phone=p.phone.replace(/[\s()-]/g,'');
  if(!/^RU\/[A-Z0-9-]+\/[0-9]{4}\/[0-9]{1,8}$/.test(p.registration_number)){out.textContent='Weka reg. number kama RU/BAFIT/2024/007.';return;}
  if(!/^\+?[0-9]{9,15}$/.test(p.phone)){out.textContent='Weka namba ya simu sahihi.';return;}
  if(p.evidence_url&&!safeUrl(p.evidence_url)){out.textContent='Kiungo cha ushahidi kiwe cha HTTPS.';return;}
  const b=form.querySelector('[type="submit"]');b.disabled=true;out.textContent='Inatuma kwa Wizara ya Elimu…';
  try{
   const r=await rpc('submit_education_feedback',{p_payload:p});
   out.replaceChildren(el('h2','Taarifa yako imepokelewa.'),el('p','Hifadhi namba hii na msimbo wa siri ili kufuatilia majibu.'),el('code',r.reference,'case-secret'),el('code',r.tracking_token,'case-secret'),el('p',r.role_verified?'Cheo kimethibitishwa kwa akaunti.':'Cheo / taarifa za utambulisho zimejazwa na mtumaji.'));
   const a=el('a','Fuatilia taarifa hii','btn btn--ghost');a.href='#education-tracking';a.addEventListener('click',()=>{$('education-track').elements.reference.value=r.reference;$('education-track').elements.token.value=r.tracking_token;});out.append(a);
   form.reset();roleNote();
  }catch(e){out.textContent=error(e);}finally{b.disabled=false;}
 });
 $('education-track').addEventListener('submit',async ev=>{
  ev.preventDefault();const f=ev.currentTarget,out=$('education-track-result');if(!f.reportValidity())return;
  if(!uuid(f.elements.token.value.trim())){out.textContent='Hakiki msimbo wa siri uliopewa.';return;}
  const b=f.querySelector('button');b.disabled=true;out.textContent='Inatafuta majibu…';
  try{const r=await rpc('track_education_feedback',{p_reference:f.elements.reference.value.trim().toUpperCase(),p_token:f.elements.token.value.trim()});out.replaceChildren();
   if(!r){out.textContent='Hakuna taarifa inayolingana na kumbukumbu na msimbo huo.';return;}
   out.append(el('h3',window.RucusoCommunity.labels[r.status]||r.status),el('p',`${roles[r.sender_role]} · ${r.role_verified?'Cheo kimethibitishwa':'Amejitambulisha mwenyewe'}`));
   for(const reply of r.replies||[])out.append(el('p',`${date(reply.created_at)} · ${window.RucusoCommunity.labels[reply.status]||reply.status}\n${reply.reply}`,'notice'));
   if(!r.replies?.length)out.append(el('p','Bado hakuna jibu.'));
  }catch(e){out.textContent=error(e);}finally{b.disabled=false;}
 });
 async function init(){const info=await rpc('education_public_info',{});if(!info)throw new Error('NOT_CONFIGURED');$('education-title').textContent=info.title;open=info.is_open;form.hidden=!open;$('education-status').textContent=open?'Kupokea maoni kuko wazi. Taarifa hazitaonekana kwa wanafunzi wengine.':'Kupokea maoni kumefungwa kwa sasa.';await refreshIdentity();}
 init().catch(e=>{$('education-status').textContent=error(e);});
})();
