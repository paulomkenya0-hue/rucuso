(function(){
 'use strict';
 const {$,el,rpc,error}=window.RucusoCommunity;
 const modules={education:{label:'Elimu',match:/elimu|education/i},security:{label:'Ulinzi',match:/ulinzi|security|defen[cs]e/i},sports:{label:'Michezo',match:/michezo|sport/i},loans:{label:'Mikopo',match:/mikopo|loan/i}};
 const status=t=>$('staff-portals-status').textContent=t;
 async function cards(){const rows=await rpc('staff_portal_overview');$('staff-portals').replaceChildren();for(const row of rows){const box=el('article',null,'card'),a=el('a',row.label,'btn btn--primary');a.href=row.href;box.append(a,el('p',`Jumla: ${row.total}`+(row.new===undefined?'':` · Mpya: ${row.new}`)));$('staff-portals').append(box);}status(rows.length?'Fungua huduma inayokuhusu kusoma na kushughulikia taarifa.':'Hakuna inbox binafsi iliyoruhusiwa kwa cheo hiki. Msimamizi ahakiki nafasi na wizara ya akaunti.');}
 async function routes(){
  const [rows,result]=await Promise.all([rpc('staff_portal_routes'),window.RucusoAPI.client.from('ministries').select('id,name').eq('active',true).order('name')]);if(result.error)throw result.error;
  const panel=$('staff-route-panel');panel.replaceChildren();panel.hidden=false;
  for(const row of rows){const module=modules[row.key];if(!module)continue;const form=el('form',null,'study-form'),select=el('select');select.required=true;select.setAttribute('aria-label','Wizara ya '+module.label);
   for(const m of result.data.filter(m=>module.match.test(m.name))){const option=el('option',m.name);option.value=m.id;select.append(option);}select.value=row.ministry_id;
   const save=el('button','Hifadhi wizara','btn btn--primary');save.type='submit';form.append(el('h2',module.label),el('p',`Inapokea: ${row.ministry||'Haijapangwa'} · Akaunti hai za Waziri/Naibu: ${row.handlers??row.ministers}`),select,save);
   if(!(row.handlers??row.ministers)){const a=el('a','Unda au hakiki akaunti ya Waziri / Naibu','btn btn--ghost');a.href='/admin/leaders/';form.append(a);}
   form.addEventListener('submit',async e=>{e.preventDefault();if(!form.reportValidity())return;save.disabled=true;try{await rpc('set_staff_portal_route',{p_module:row.key,p_ministry:select.value});await routes();await cards();}catch(err){status(error(err));}finally{save.disabled=false;}});panel.append(form);
  }
 }
 (async()=>{const session=await window.RucusoGuard.requireRole(['super_admin','leader'],{loginUrl:'/leader/login/'});if(!session)return;try{await cards();}catch(e){status(error(e));}if($('staff-route-panel')&&session.profile.role==='super_admin')try{await routes();}catch(e){status(error(e));}})().catch(e=>status(error(e)));
})();
