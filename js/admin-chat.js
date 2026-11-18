(function () {
  'use strict';
  const {$,el,error,rpc,labels}=window.RucusoCommunity;
  const client=window.RucusoAPI?.client;
  let offset=0,loading=false;
  const status=text=>$('approval-status').textContent=text;
  async function countPending(){
    const r=await client.from('community_members').select('user_id',{count:'exact',head:true}).eq('status','pending');
    if(r.error)throw r.error;
    $('approval-count').textContent=`Maombi ${r.count} yanasubiri kuidhinishwa.`;
  }
  function memberCard(m){
    const card=el('article',null,'study-card');
    card.append(el('h2',m.display_name),el('p',`${m.programme} · Mwaka ${m.study_year}`),el('p',`Reg. number: ${m.registration_number||'Mwaka 1 — hakiki manually'}`),el('p','Hali: '+(labels[m.status]||m.status),'study-meta'));
    const actions=el('div',null,'study-actions');
    for(const [next,label]of [['approved','Approve / Ruhusu kuingia'],['rejected','Kataa ombi'],['suspended','Simamisha'],['pending','Rudisha ukaguzi']]){
      if(next===m.status)continue;
      const b=el('button',label,next==='approved'?'btn btn--primary':'btn btn--ghost');b.type='button';
      b.addEventListener('click',async()=>{
        const controls=actions.querySelectorAll('button');controls.forEach(x=>x.disabled=true);
        try{
          await rpc('moderate_community_member',{p_user:m.user_id,p_status:next});
          await load(true);
          status(next==='approved'?`${m.display_name} ameruhusiwa. Mwanafunzi abonyeze “Angalia hali ya ombi” kwenye chat.`:'Hali ya ombi imehifadhiwa.');
        }catch(e){status(error(e));}finally{controls.forEach(x=>x.disabled=false);}
      });actions.append(b);
    }
    card.append(actions);return card;
  }
  async function load(reset){
    if(loading)return;loading=true;$('approval-refresh').disabled=true;$('approval-more').disabled=true;
    if(reset){offset=0;$('approval-list').replaceChildren();}
    try{
      const r=await client.from('community_members').select('user_id,display_name,programme,study_year,registration_number,status,created_at').eq('status',$('approval-state').value).order('created_at',{ascending:false}).order('user_id').range(offset,offset+19);
      if(r.error)throw r.error;
      r.data.forEach(m=>$('approval-list').append(memberCard(m)));offset+=r.data.length;
      $('approval-more').hidden=r.data.length<20;
      if(!offset)$('approval-list').append(el('p','Hakuna maombi katika hali hii. Kama mwanafunzi ameingia Google tu, amalizie “Tuma ombi la kujiunga” kwanza.','notice'));
      await countPending();
    }finally{loading=false;$('approval-refresh').disabled=false;$('approval-more').disabled=false;}
  }
  async function init(){
    const session=await window.RucusoGuard.requireRole(['super_admin','admin'],{loginUrl:'/admin/login/'});if(!session)return;
    if(!await rpc('can_moderate_community',{})){status('Akaunti hii inahitaji ruhusa ya manage_feedback.');return;}
    $('approval-panel').hidden=false;
    $('approval-state').addEventListener('change',()=>load(true).catch(e=>status(error(e))));
    $('approval-refresh').addEventListener('click',()=>load(true).catch(e=>status(error(e))));
    $('approval-more').addEventListener('click',()=>load(false).catch(e=>status(error(e))));
    await load(true);status('Chagua “Approve / Ruhusu kuingia” baada ya kuhakiki mwanafunzi.');
  }
  init().catch(e=>status(error(e)));
})();
