(function(){
 'use strict';
 const {$,el,rpc,date,labels,button}=window.RucusoCommunity;
 const {roles,kinds,categories,uuid,safeUrl,error}=window.RucusoEducation;
 const client=window.RucusoAPI?.client;
 const field=name=>document.querySelector(`[name="${name}"]`);
 let selectedRole=null,offset=0,version=0,loading=false,repOffset=0,repLoading=false;
 const status=text=>$('education-admin-status').textContent=text;
 function entry(f){
  const card=el('article',null,'study-card education-entry');card.append(el('span',roles[f.sender_role],'eyebrow'),el('h2',f.title),el('span',f.role_verified?'Cheo kimethibitishwa kwa akaunti':'Amejitambulisha mwenyewe — cheo hakijathibitishwa','education-badge'));
  card.append(el('p',`${f.full_name}\n${f.registration_number}\n${f.course} · Mwaka ${f.study_year}\nSimu: ${f.phone}`));
  if(f.role_scope)card.append(el('p','Anachowakilisha: '+f.role_scope));
  card.append(el('p',`${kinds[f.kind]} · ${categories[f.category]} · ${labels[f.status]}\n${f.reference} · ${date(f.created_at)}`,'study-meta'),el('p',f.description));
  if(f.solution)card.append(el('p','Suluhisho lililopendekezwa:\n'+f.solution));
  const url=safeUrl(f.evidence_url);if(url){const a=el('a','Fungua ushahidi wa nje ↗','btn btn--ghost');a.href=url;a.target='_blank';a.rel='noopener noreferrer';card.append(a);}
  const history=el('div');card.append(button('Historia ya majibu',async()=>{const r=await client.from('education_replies').select('status,reply,created_at').eq('feedback_id',f.id).order('created_at',{ascending:false}).limit(30);if(r.error)throw r.error;history.replaceChildren(...r.data.map(x=>el('p',`${date(x.created_at)} · ${labels[x.status]}\n${x.reply}`,'notice')));}),history);
  const form=el('form'),state=el('select'),reply=el('textarea'),save=el('button','Hifadhi hatua na jibu','btn btn--primary');state.setAttribute('aria-label','Hali ya taarifa');
  for(const key of ['submitted','in_progress','waiting','resolved','closed']){const o=el('option',labels[key]);o.value=key;state.append(o);}state.value=f.status;
  reply.required=true;reply.minLength=3;reply.maxLength=2000;reply.rows=3;reply.placeholder='Jibu litakaloonekana kwa mtumaji anayefuatilia';reply.setAttribute('aria-label','Jibu kwa mtumaji');save.type='submit';form.append(state,reply,save);
  form.addEventListener('submit',async ev=>{ev.preventDefault();if(!form.reportValidity())return;save.disabled=true;try{await rpc('reply_education_feedback',{p_id:f.id,p_status:state.value,p_reply:reply.value.trim()});await load(true);status('Jibu limehifadhiwa kwenye historia ya taarifa.');}catch(e){status(error(e));}finally{save.disabled=false;}});card.append(form);return card;
 }
 async function load(reset){
  if(loading&&!reset)return;const ticket=++version;loading=true;$('education-more').disabled=true;
  if(reset){offset=0;$('education-list').replaceChildren();}
  try{const r=await rpc('list_education_feedback',{p_role:selectedRole,p_kind:field('ed_kind').value||null,p_status:field('ed_status').value||null,p_course:field('ed_course').value.trim()||null,p_year:Number(field('ed_year').value)||null,p_offset:offset});if(ticket!==version)return;
   r.rows.forEach(f=>$('education-list').append(entry(f)));offset+=r.rows.length;$('education-count').textContent=`Taarifa ${offset} kati ya ${r.total} katika chaguo hili.`;$('education-more').hidden=offset>=r.total;
   if(!r.total)$('education-list').append(el('p','Hakuna taarifa zinazolingana na chaguo hili.','notice'));
  }finally{if(ticket===version){loading=false;$('education-more').disabled=false;}}
 }
 async function loadReps(reset){
  if(repLoading)return;repLoading=true;if(reset){repOffset=0;$('education-reps').replaceChildren();}
  try{const r=await client.from('education_representatives').select('*').order('full_name').order('user_id').order('role').range(repOffset,repOffset+29);if(r.error)throw r.error;
   for(const p of r.data){const card=el('article',null,'study-card');card.append(el('h3',p.full_name),el('p',`${roles[p.role]} · ${p.scope}\n${p.registration_number||''}\n${p.course||''}\nAccount ID: ${p.user_id}`),el('p',p.active?'Kiungo kiko active':'Kiungo kimezimwa','study-meta'),button(p.active?'Zima uthibitisho':'Washa uthibitisho',async()=>{await rpc('set_education_representative_active',{p_account:p.user_id,p_role:p.role,p_active:!p.active});await loadReps(true);}));$('education-reps').append(card);}
   repOffset+=r.data.length;$('education-reps-more').hidden=r.data.length<30;if(!repOffset)$('education-reps').append(el('p','Hakuna CR / Mbunge aliyeunganishwa bado.'));
  }finally{repLoading=false;}
 }
 async function setupSuper(){
  const settings=await client.from('education_settings').select('*').eq('id',1).single();if(settings.error)throw settings.error;
  const ministries=await client.from('ministries').select('id,name').eq('active',true).order('name');if(ministries.error)throw ministries.error;
  const f=$('education-settings');f.elements.title.value=settings.data.title;f.elements.is_open.value=String(settings.data.is_open);
  for(const m of ministries.data){const o=el('option',m.name);o.value=m.id;f.elements.ministry.append(o);}f.elements.ministry.value=settings.data.ministry_id;$('education-settings-panel').hidden=false;
  f.addEventListener('submit',async ev=>{ev.preventDefault();if(!f.reportValidity())return;const b=f.querySelector('button');b.disabled=true;try{await rpc('configure_education',{p_title:f.elements.title.value.trim(),p_open:f.elements.is_open.value==='true',p_ministry:f.elements.ministry.value});status('Mipangilio ya elimu imehifadhiwa.');}catch(e){status(error(e));}finally{b.disabled=false;}});
  $('education-registry-panel').hidden=false;const rep=$('education-rep-form');
  try{const r=await client.from('parliament_members').select('id,full_name,constituency').eq('active',true).order('full_name');if(r.error)throw r.error;for(const m of r.data){const o=el('option',m.full_name+(m.constituency?' — '+m.constituency:''));o.value=m.id;rep.elements.parliament.append(o);}}catch(e){status('Orodha ya elimu inapatikana; orodha ya Bunge haijapatikana kwa uthibitisho mpya.');}
  function repRole(){const mp=rep.elements.role.value==='mp';rep.elements.name.required=!mp;rep.elements.name.closest('label').hidden=mp;rep.elements.parliament.required=mp;rep.elements.parliament.closest('label').hidden=!mp;}
  rep.elements.role.addEventListener('change',repRole);repRole();
  rep.addEventListener('submit',async ev=>{ev.preventDefault();if(!rep.reportValidity())return;if(!uuid(rep.elements.account.value.trim())){status('Account ID lazima iwe ile UUID anayoona mhusika baada ya kuingia.');return;}const b=rep.querySelector('button');b.disabled=true;
   try{await rpc('save_education_representative',{p_account:rep.elements.account.value.trim(),p_role:rep.elements.role.value,p_name:rep.elements.name.value.trim(),p_reg:rep.elements.reg.value.trim(),p_course:rep.elements.course.value.trim(),p_year:Number(rep.elements.year.value)||null,p_scope:rep.elements.scope.value.trim(),p_parliament:rep.elements.parliament.value||null});await loadReps(true);rep.reset();repRole();status('Cheo kimeunganishwa na akaunti. Taarifa mpya zitatumia uthibitisho huo; taarifa za zamani hazibadilishwi.');}catch(e){status(error(e));}finally{b.disabled=false;}
  });
  $('education-reps-refresh').addEventListener('click',()=>loadReps(true).catch(e=>status(error(e))));$('education-reps-more').addEventListener('click',()=>loadReps(false).catch(e=>status(error(e))));await loadReps(true);
 }
 async function init(){
  const session=await window.RucusoGuard.requireRole(['super_admin','leader'],{loginUrl:'/admin/login/'});if(!session)return;
  if(!await rpc('can_manage_education',{})){status('Sehemu hii ni ya Waziri wa Elimu na super admin pekee. Naibu, Katibu na wizara nyingine hawana ruhusa.');return;}
  $('education-inbox').hidden=false;
  for(const[role,label]of [[null,'Wote'],...Object.entries(roles)]){const b=el('button',label,'btn btn--ghost');b.type='button';b.setAttribute('aria-pressed',String(role===selectedRole));b.addEventListener('click',()=>{selectedRole=role;for(const n of $('education-tabs').children)n.setAttribute('aria-pressed',String(n===b));load(true).catch(e=>status(error(e)));});$('education-tabs').append(b);}
  for(const key of ['ed_kind','ed_status','ed_year'])field(key).addEventListener('change',()=>load(true).catch(e=>status(error(e))));
  $('education-refresh').addEventListener('click',()=>load(true).catch(e=>status(error(e))));$('education-more').addEventListener('click',()=>load(false).catch(e=>status(error(e))));
  $('education-reset').addEventListener('click',()=>{selectedRole=null;for(const key of ['ed_kind','ed_status','ed_year','ed_course'])field(key).value='';for(const[n,b]of [...$('education-tabs').children].entries())b.setAttribute('aria-pressed',String(n===0));load(true).catch(e=>status(error(e)));});
  await load(true);status('Umeingia: '+session.profile.full_name+' ('+session.profile.role+').');
  if(session.profile.role==='super_admin')try{await setupSuper();}catch(e){status('Orodha imepakia; mipangilio haijapatikana. '+error(e));}
 }
 init().catch(e=>status(error(e)));
})();
