(function () {
  'use strict';
  const {$,el,date,error,rpc,button,labels}=window.RucusoCommunity;
  const client=window.RucusoAPI?.client;
  let caseOffset=0,memberOffset=0,caseLoading=false,memberLoading=false;
  function notice(text){$('staff-status').textContent=text;}
  function statusSelect(value,values) {const s=el('select');s.setAttribute('aria-label','Badilisha hali');for(const v of values){const o=el('option',labels[v]||v);o.value=v;s.append(o);}s.value=value;return s;}
  function caseCard(c) {
    const box=el('article',null,'study-card case-card');
    box.append(el('span',c.kind==='lost'?'Nimepoteza':c.kind==='found'?'Nimeokota':'Maoni — mwaka wa kwanza','eyebrow'),el('h3',c.title),el('p',c.reference+' · '+(labels[c.status]||c.status),'study-meta'));
    box.append(el('p',`${c.full_name}\n${c.programme} · Mwaka ${c.study_year}\nSimu: ${c.phone}`));
    if(c.kind!=='first_year_feedback')box.append(el('p',`Makazi: ${c.residence_name}\nEneo la tukio: ${c.incident_location}\nTarehe ya tukio: ${c.incident_date}`));
    box.append(el('p',c.description),el('p','Taarifa za utambulisho zimejazwa na mtumaji; hazijathibitishwa moja kwa moja na database.','study-meta'));
    box.append(el('p',`Imepokelewa: ${date(c.created_at)}\nLengo la jibu la kwanza: ${date(c.response_due_at)}`,'study-meta'));
    if(!c.first_response_at&&Date.now()>new Date(c.response_due_at).getTime())box.append(el('p','Jibu la kwanza limechelewa: zaidi ya saa 24.','notice'));
    if(c.public_reply)box.append(el('p','Jibu la mwisho: '+c.public_reply,'notice'));
    const history=el('div');box.append(button('Historia ya majibu',async()=>{
      const r=await client.from('student_case_updates').select('status,public_reply,created_at').eq('case_id',c.id).order('created_at',{ascending:false}).limit(20);if(r.error)throw r.error;
      history.replaceChildren(...r.data.map(u=>el('p',`${date(u.created_at)} · ${labels[u.status]||u.status}\n${u.public_reply}`,'notice')));
    }),history);
    const form=el('form');const select=statusSelect(c.status,['submitted','in_progress','waiting','resolved','closed']);
    const reply=el('textarea');reply.required=true;reply.minLength=3;reply.maxLength=2000;reply.rows=3;reply.placeholder='Jibu litakaloonekana kwa mtumaji anayefuatilia kesi';reply.setAttribute('aria-label','Jibu kwa mtumaji');
    const save=el('button','Hifadhi hatua na jibu','btn btn--primary');save.type='submit';form.append(select,reply,save);
    form.addEventListener('submit',async ev=>{ev.preventDefault();if(!form.reportValidity())return;save.disabled=true;try{await rpc('update_student_case',{p_id:c.id,p_status:select.value,p_reply:reply.value.trim()});await loadCases(true);notice('Jibu limehifadhiwa.');}catch(e){notice(error(e));}finally{save.disabled=false;}});
    box.append(form);return box;
  }
  async function loadCases(reset) {
    if(caseLoading)return;caseLoading=true;$('case-more').disabled=true;
    if(reset){caseOffset=0;$('case-list').replaceChildren();}
    try {
      let q=client.from('student_cases').select('id,reference,kind,full_name,programme,study_year,phone,title,description,incident_date,incident_location,residence_name,status,public_reply,created_at,response_due_at,first_response_at').order('created_at',{ascending:false}).order('id');
      q=$('case-kind').value==='security'?q.in('kind',['lost','found']):q.eq('kind','first_year_feedback');
      if($('case-state').value)q=q.eq('status',$('case-state').value);
      const r=await q.range(caseOffset,caseOffset+19);if(r.error)throw r.error;
      r.data.forEach(c=>$('case-list').append(caseCard(c)));caseOffset+=r.data.length;
      $('case-more').hidden=r.data.length<20;if(!caseOffset)$('case-list').append(el('p','Hakuna ripoti katika chaguo hili.'));
    }finally{caseLoading=false;$('case-more').disabled=false;}
  }
  async function loadMembers(reset) {
    if(memberLoading)return;memberLoading=true;if(reset){memberOffset=0;$('member-list').replaceChildren();}
    try{
      const r=await client.from('community_members').select('*').eq('status',$('member-state').value).order('created_at',{ascending:false}).order('user_id').range(memberOffset,memberOffset+19);if(r.error)throw r.error;
      for(const m of r.data){const box=el('article',null,'study-card');box.append(el('h3',m.display_name),el('p',`${m.programme} · Mwaka ${m.study_year}\nReg: ${m.registration_number||'Mwaka 1 — hakiki manually'}`),el('p','Akaunti: '+m.user_id,'study-meta'));
        for(const [status,label] of [['approved','Ruhusu baada ya kuhakiki'],['suspended','Simamisha'],['rejected','Kataa'],['pending','Rudisha ukaguzi']])if(status!==m.status)box.append(button(label,async()=>{await rpc('moderate_community_member',{p_user:m.user_id,p_status:status});await loadMembers(true);}));
        $('member-list').append(box);
      }
      memberOffset+=r.data.length;$('member-more').hidden=r.data.length<20;if(!memberOffset)$('member-list').append(el('p','Hakuna akaunti katika hali hii.'));
    }finally{memberLoading=false;}
  }
  async function loadModeration(){
    const reports=await client.from('community_reports').select('id,message_id,reason,created_at').order('created_at',{ascending:false}).limit(50);if(reports.error)throw reports.error;
    $('moderation-reports').replaceChildren(el('h3','Ujumbe ulioripotiwa'));
    for(const r of reports.data){const n=el('article',null,'notice');n.append(el('p',`Ujumbe #${r.message_id} · ${date(r.created_at)}\nSababu: ${r.reason}`),button('Ondoa ujumbe',async()=>{await rpc('remove_community_message',{p_message:r.message_id});await loadModeration();}));$('moderation-reports').append(n);}
    const rows=await rpc('read_community_messages',{p_before:null});$('moderation-messages').replaceChildren(el('h3','Ujumbe 50 wa karibuni'));
    for(const m of rows){const n=el('article',null,'notice');n.append(el('strong',`${m.display_name} · #${m.id}`),el('p',m.body),el('p',date(m.created_at),'study-meta'),button('Ondoa ujumbe',async()=>{await rpc('remove_community_message',{p_message:m.id});await loadModeration();}));$('moderation-messages').append(n);}
  }
  async function init(){
    const session=await window.RucusoGuard.requireRole(['super_admin','admin','leader'],{loginUrl:'/leader/login/'});if(!session)return;
    const [security,feedback,moderator]=await Promise.all([rpc('can_manage_security_cases',{}),rpc('can_manage_first_year_feedback',{}),rpc('can_moderate_community',{})]);
    if(!security&&!feedback&&!moderator){notice('Akaunti hii haina ruhusa ya huduma hizi.');return;}
    notice('Umeingia kama '+session.profile.full_name);$('staff-logout').hidden=false;$('staff-logout').addEventListener('click',()=>window.RucusoGuard.logout('/'));
    if(security||feedback){
      $('case-panel').hidden=false;
      if(!security)$('case-kind').querySelector('[value="security"]').remove();
      if(!feedback)$('case-kind').querySelector('[value="first_year_feedback"]').remove();
      for(const id of ['case-kind','case-state'])$(id).addEventListener('change',()=>loadCases(true).catch(e=>notice(error(e))));
      $('case-refresh').addEventListener('click',()=>loadCases(true).catch(e=>notice(error(e))));$('case-more').addEventListener('click',()=>loadCases(false).catch(e=>notice(error(e))));
      await loadCases(true);
      async function unread(){const r=await client.from('student_cases').select('id',{count:'exact',head:true}).eq('status','submitted');if(!r.error)$('staff-inbox').textContent=`Ripoti mpya zinazokusubiri: ${r.count}`;}
      await unread();const timer=setInterval(()=>{if(!document.hidden)unread();},30000);window.addEventListener('pagehide',()=>clearInterval(timer));
    }
    if(moderator){
      $('membership-panel').hidden=false;$('moderation-panel').hidden=false;
      $('member-state').addEventListener('change',()=>loadMembers(true).catch(e=>notice(error(e))));$('member-more').addEventListener('click',()=>loadMembers(false).catch(e=>notice(error(e))));
      $('moderation-refresh').addEventListener('click',()=>loadModeration().catch(e=>notice(error(e))));await loadMembers(true);await loadModeration();
    }
    if(session.profile.role==='super_admin'){
      const [settings,ministries]=await Promise.all([client.from('student_service_settings').select('security_ministry_id').single(),client.from('ministries').select('id,name').eq('active',true).order('name')]);if(settings.error)throw settings.error;if(ministries.error)throw ministries.error;
      const choose=el('select');choose.setAttribute('aria-label','Wizara ya Ulinzi');for(const m of ministries.data){const o=el('option',m.name);o.value=m.id;choose.append(o);}choose.value=settings.data.security_ministry_id;
      $('settings-controls').append(choose,button('Hifadhi wizara inayopokea ripoti',async()=>{const r=await client.from('student_service_settings').update({security_ministry_id:choose.value}).eq('id',true).select('id');if(r.error)throw r.error;if(!r.data.length)throw new Error('NOT_AUTHORIZED');notice('Wizara inayopokea ripoti imehifadhiwa.');}));$('settings-panel').hidden=false;
    }
  }
  init().catch(e=>notice(error(e)));
})();
