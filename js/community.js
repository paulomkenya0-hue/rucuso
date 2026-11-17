(function () {
  'use strict';
  const {$,el,date,error,rpc,button,labels}=window.RucusoCommunity;
  const client=window.RucusoAPI?.client;
  let member=null, poll=null, chatBusy=false, oldest=null;
  const messages=new Map();
  const hostels={campus_boys:['Nkembo','Katikaza'],campus_girls:['NMB line','Kamzora','Sisters','Elizabeth'],lugalo:['Lugalo']};
  const security=$('security-form');
  function residence() {
    const type=security.elements.residence_type.value;
    const manual=type==='offcampus';
    $('hostel-label').hidden=manual;
    const input=security.elements.residence_detail;
    input.closest('label').hidden=!manual; input.required=manual; input.disabled=!manual;
    const select=security.elements.hostel;
    select.replaceChildren(...(hostels[type]||[]).map(v=>{const o=el('option',v);o.value=v;return o;}));
    select.disabled=manual;
  }
  security.elements.residence_type.addEventListener('change',residence);residence();
  security.elements.incident_date.max=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Dar_es_Salaam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  function showReceipt(target,data) {
    target.replaceChildren(el('h3','Imepokelewa. Hifadhi taarifa hizi sasa.'));
    target.append(el('p','Namba ya kumbukumbu'),el('code',data.reference,'case-secret'),el('p','Msimbo wa siri — usiushirikishe hadharani'),el('code',data.tracking_token,'case-secret'),el('p','Lengo la jibu la kwanza: '+date(data.response_due_at)));
    const a=el('a','Fuatilia ripoti hii','btn btn--ghost');a.href='#tracking';
    a.addEventListener('click',()=>{const f=$('tracking-form');f.elements.reference.value=data.reference;f.elements.token.value=data.tracking_token;});target.append(a);
    // Contact and residence details are never put in URLs or localStorage.
  }
  function caseForm(form,resultId) {
    form.addEventListener('submit',async ev=>{
      ev.preventDefault();if(!form.reportValidity())return;
      const b=form.querySelector('[type="submit"]');const target=$(resultId);b.disabled=true;target.textContent='Inatuma…';
      try {
        const data={};for(const key of ['kind','full_name','programme','study_year','phone','title','description'])data[key]=form.elements[key].value.trim();
        data.study_year=Number(data.study_year);
        if(data.kind!=='first_year_feedback') {
          for(const key of ['incident_date','incident_location','residence_type'])data[key]=form.elements[key].value.trim();
          data.residence_name=data.residence_type==='offcampus'?form.elements.residence_detail.value.trim():form.elements.hostel.value;
        }
        const receipt=await rpc('submit_student_case',{p_payload:data});
        form.reset();if(form===security)residence();showReceipt(target,receipt);
      }catch(e){target.textContent=error(e);}finally{b.disabled=false;}
    });
  }
  caseForm(security,'security-result');caseForm($('first-year-form'),'feedback-result');
  $('feedback-year').addEventListener('change',()=>{
    const year=$('feedback-year').value;
    $('first-year-form').hidden=year!=='1';$('continuing-feedback').hidden=!['2','3','4'].includes(year);
    $('verified-feedback-link').href='/?feedback_year='+encodeURIComponent(year)+'#submit';
  });
  $('tracking-form').addEventListener('submit',async ev=>{
    ev.preventDefault();const f=ev.currentTarget;const out=$('tracking-result');const b=f.querySelector('button');b.disabled=true;out.textContent='Inatafuta…';
    try {
      const token=f.elements.token.value.trim();
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token))throw new Error('INVALID_TOKEN');
      const data=await rpc('track_student_case',{p_reference:f.elements.reference.value.trim().toUpperCase(),p_token:token});
      out.replaceChildren();if(!data){out.textContent='Hakuna ripoti inayolingana na taarifa hizo mbili.';return;}
      out.append(el('h3',labels[data.status]||data.status),el('p','Imepokelewa: '+date(data.created_at)),el('p','Lengo la jibu la kwanza: '+date(data.response_due_at)));
      if(!data.first_response_at&&Date.now()>new Date(data.response_due_at).getTime())out.append(el('p','Jibu la kwanza limevuka lengo la saa 24. Ripoti yako bado iko wazi.','notice'));
      for(const u of data.updates||[])out.append(el('p',`${date(u.created_at)} · ${labels[u.status]||u.status}\n${u.reply}`,'notice'));
      if(!(data.updates||[]).length)out.append(el('p','Bado hakuna jibu.'));
    }catch(e){out.textContent=error(e);}finally{b.disabled=false;}
  });
  function stopChat() {clearInterval(poll);poll=null;member=null;messages.clear();oldest=null;$('chat-room').hidden=true;$('chat-messages').replaceChildren();}
  async function chatState() {
    stopChat();if(!client){$('chat-status').textContent='Huduma haijaunganishwa bado.';return;}
    const {data:{session}}=await client.auth.getSession();
    $('chat-auth').hidden=!!session;$('chat-session').hidden=!session;$('chat-join').hidden=true;
    if(!session){$('chat-status').textContent='Bonyeza “Endelea na Google” ili kuomba kujiunga.';return;}
    try {
      if(sessionStorage.getItem('rucuso_chat_google_return')==='1') {
        sessionStorage.removeItem('rucuso_chat_google_return');
        document.getElementById('chat').scrollIntoView({block:'start'});
      }
    } catch (_) { /* returning to chat must still work when storage is unavailable */ }
    const {data,error:e}=await client.from('community_members').select('user_id,status').eq('user_id',session.user.id).maybeSingle();if(e)throw e;
    if(!data){
      const name=String(session.user.user_metadata?.full_name||session.user.user_metadata?.name||'').slice(0,80);
      if(!$('chat-join').elements.display_name.value)$('chat-join').elements.display_name.value=name;
      $('chat-join').hidden=false;$('chat-status').textContent='Akaunti imeingia. Tuma ombi la kujiunga.';return;}
    member=data;
    if(data.status!=='approved'){$('chat-status').textContent='Hali ya ombi: '+(labels[data.status]||data.status)+'. Bonyeza “Angalia hali ya ombi” baada ya ukaguzi.';return;}
    $('chat-room').hidden=false;$('chat-status').textContent='Umeruhusiwa. Ujumbe mpya huangaliwa kila sekunde 8 ukiwa kwenye ukurasa huu.';
    await loadMessages(false);
    poll=setInterval(()=>{if(!document.hidden)loadMessages(false).catch(e=>{$('chat-status').textContent=error(e);stopChat();});},8000);
  }
  async function signInGoogle() {
    const btn=$('chat-google');
    if(!client){$('chat-status').textContent='Huduma haijaunganishwa bado.';return;}
    btn.disabled=true;$('chat-status').textContent='Inakuelekeza Google…';
    try {
      try { sessionStorage.setItem('rucuso_chat_google_return','1'); } catch (_) {}
      const {error:e}=await client.auth.signInWithOAuth({
        provider:'google',
        options:{redirectTo:location.origin+'/community/',queryParams:{prompt:'select_account'}}
      });
      if(e)throw e;
    }catch(e){
      try { sessionStorage.removeItem('rucuso_chat_google_return'); } catch (_) {}
      $('chat-status').textContent=error(e);btn.disabled=false;
    }
  }
  $('chat-google').addEventListener('click',signInGoogle);
  $('chat-logout').addEventListener('click',async()=>{stopChat();await client.auth.signOut();await chatState();});
  $('chat-check').addEventListener('click',()=>chatState().catch(e=>{$('chat-status').textContent=error(e);}));
  const join=$('chat-join');
  function regRequired(){join.elements.registration_number.required=join.elements.study_year.value!=='1';}regRequired();join.elements.study_year.addEventListener('change',regRequired);
  join.addEventListener('submit',async ev=>{
    ev.preventDefault();if(!join.reportValidity())return;const b=join.querySelector('button');b.disabled=true;
    try{await rpc('join_community',{p_name:join.elements.display_name.value.trim(),p_programme:join.elements.programme.value.trim(),p_year:Number(join.elements.study_year.value),p_registration:join.elements.registration_number.value.trim()||null});await chatState();}
    catch(e){$('chat-status').textContent=error(e);}finally{b.disabled=false;}
  });
  function renderMessages() {
    const list=$('chat-messages');const atBottom=list.scrollTop+list.clientHeight>=list.scrollHeight-60;
    list.replaceChildren();
    [...messages.values()].sort((a,b)=>Number(a.id)-Number(b.id)).forEach(m=>{
      const li=el('li',null,'chat-message'+(m.is_mine?' chat-message--mine':''));li.append(el('strong',m.display_name),el('p',m.body),el('span',date(m.created_at),'study-meta'));
      if(!m.is_mine)li.append(button('Ripoti ujumbe',async()=>{const reason=prompt('Sababu ya kuripoti (angalau herufi 3):');if(!reason||reason.trim().length<3)return;await rpc('report_community_message',{p_message:m.id,p_reason:reason.slice(0,500)});$('chat-status').textContent='Ripoti ya ujumbe imetumwa kwa msimamizi.';}));
      list.append(li);
    });
    if(atBottom)list.scrollTop=list.scrollHeight;
  }
  async function loadMessages(older) {
    if(chatBusy||!member||member.status!=='approved')return;chatBusy=true;
    try {
      const rows=await rpc('read_community_messages',{p_before:older?oldest:null});
      if(!older&&rows.length){const min=Math.min(...rows.map(x=>Number(x.id)));const ids=new Set(rows.map(x=>String(x.id)));for(const [id] of messages)if(Number(id)>=min&&!ids.has(String(id)))messages.delete(id);}
      if(!older&&!rows.length)messages.clear();
      rows.forEach(m=>messages.set(String(m.id),m));
      if(older||oldest===null)oldest=rows.length?rows[rows.length-1].id:oldest;
      if(older||messages.size<=50)$('chat-older').hidden=rows.length<50;
      renderMessages();
    }finally{chatBusy=false;}
  }
  const send=$('chat-send');
  const field=send.elements.body;
  const submit=send.querySelector('[type="submit"]');
  send.addEventListener('submit',async ev=>{ev.preventDefault();if(!send.reportValidity())return;submit.disabled=true;try{await rpc('send_community_message',{p_body:field.value.trim()});field.value='';await loadMessages(false);}catch(e){$('chat-status').textContent=error(e);}finally{submit.disabled=false;}});
  $('chat-older').addEventListener('click',()=>loadMessages(true).catch(e=>{$('chat-status').textContent=error(e);}));
  window.addEventListener('pagehide',stopChat);
  chatState().catch(e=>{$('chat-status').textContent=error(e);});
})();
