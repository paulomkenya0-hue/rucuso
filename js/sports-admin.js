(function(){
 'use strict';
 const {$,el,rpc,error}=window.RucusoCommunity;
 const client=window.RucusoAPI?.client;const fields=name=>document.querySelector(`[name="${name}"]`);
 let info=null,offset=0,total=0,busy=false,exporting=false,version=0,pdfReady=null;
 const message=text=>$('sports-admin-status').textContent=text;
 function filters(){return{p_sport:fields('filter_sport').value||null,p_gender:fields('filter_gender').value||null,p_course:fields('filter_course').value.trim()||null,p_year:Number(fields('filter_year').value)||null};}
 function describe(f){const label=info.sports.find(s=>s.code===f.p_sport)?.label||'Michezo yote';return `${label} | ${f.p_gender==='male'?'Wanaume':f.p_gender==='female'?'Wanawake':'Jinsia zote'} | ${f.p_course||'Kozi zote'} | ${f.p_year?'Mwaka '+f.p_year:'Miaka yote'}`;}
 function row(r){const tr=el('tr');for(const text of [r.full_name,r.registration_number,r.phone,r.course,r.study_year,r.gender==='male'?'Mwanaume':'Mwanamke',(r.sports||[]).join(', ')])tr.append(el('td',text));return tr;}
 async function summary(){info=await rpc('sports_public_info',{});$('event-heading').textContent=info.title;$('student-total').textContent=`Wanafunzi ${info.total_students} kwa jumla — waliochagua michezo mingi wamehesabiwa mara moja. Usajili: ${info.is_open?'wazi':'umefungwa'}.`;$('sports-counts').replaceChildren();for(const s of info.sports){const n=el('div',null,'sports-count');n.append(el('span',s.label),el('strong',s.count));$('sports-counts').append(n);}}
 async function load(reset){
  if(busy&&!reset)return;const ticket=++version;busy=true;$('roster-more').disabled=true;
  if(reset){offset=0;$('sports-roster').replaceChildren();}
  try{const data=await rpc('sports_roster',{...filters(),p_offset:offset,p_limit:100});if(ticket!==version)return;
   total=data.total;data.rows.forEach(r=>$('sports-roster').append(row(r)));offset+=data.rows.length;$('roster-count').textContent=`Wanafunzi ${offset} kati ya ${total} wanaolingana na vichujio.`;$('roster-more').hidden=offset>=total;
   if(reset&&!total){const tr=el('tr'),td=el('td','Hakuna washiriki wanaolingana na vichujio hivi. Bonyeza “Onyesha wote” kuondoa vichujio.');td.colSpan=7;tr.append(td);$('sports-roster').append(tr);}
  }finally{if(ticket===version){busy=false;$('roster-more').disabled=false;}}
 }
 function download(bytes,name,mime){const url=URL.createObjectURL(new Blob([bytes],{type:mime}));const a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 // A slow PDF CDN must never block the roster or Excel. Load only on demand.
 function ensurePdf(){
  if(window.jspdf?.jsPDF)return Promise.resolve();
  if(!pdfReady)pdfReady=new Promise((resolve,reject)=>{
   const script=document.createElement('script');
   script.src='https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
   script.onload=()=>resolve();
   script.onerror=()=>{pdfReady=null;reject(new Error('PDF_LIBRARY_UNAVAILABLE'));};
   document.head.append(script);
  });
  return pdfReady;
 }
 async function exportAll(type){
  if(exporting)return;exporting=true;$('export-xlsx').disabled=true;$('export-pdf').disabled=true;
  const f=filters(),title=info.title;let rows=[],expected=null;
  try{
   do{const r=await rpc('sports_roster',{...f,p_offset:rows.length,p_limit:250});if(expected===null)expected=r.total;if(!r.rows.length&&rows.length<expected)throw new Error('EXPORT_CHANGED');rows.push(...r.rows);message(`Inaandaa download: ${rows.length} / ${expected}…`);}while(rows.length<expected);
   if(!rows.length){message('Hakuna washiriki wanaolingana na vichujio hivi.');return;}
   const suffix=f.p_sport||'wote';const detail=describe(f);
   if(type==='xlsx')download(window.RucusoSportsExports.xlsx(rows,title,detail),`rucuso-michezo-${suffix}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
   else{message('Inapakia PDF…');await ensurePdf();window.RucusoSportsExports.pdf(rows,title,detail).save(`rucuso-michezo-${suffix}.pdf`);}
   message(`Download ya wanafunzi ${rows.length} imeandaliwa.`);
  }catch(e){message(e.message==='PDF_LIBRARY_UNAVAILABLE'?'Maktaba ya PDF haijapakia. Hakiki mtandao na refresh ukurasa.':error(e));}
  finally{exporting=false;$('export-xlsx').disabled=false;$('export-pdf').disabled=false;}
 }
 async function setupSettings(){
  const [event,ministries]=await Promise.all([client.from('sports_event').select('*').eq('id',1).single(),client.from('ministries').select('id,name').eq('active',true).order('name')]);if(event.error)throw event.error;if(ministries.error)throw ministries.error;
  const form=$('sports-settings'),e=event.data;form.elements.title.value=e.title;form.elements.is_open.value=String(e.is_open);
  if(e.deadline){const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Dar_es_Salaam',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(e.deadline));form.elements.deadline.value=parts.replace(' ','T');}
  for(const m of ministries.data){const option=el('option',m.name);option.value=m.id;form.elements.ministry.append(option);}form.elements.ministry.value=e.ministry_id;$('sports-settings-panel').hidden=false;
  form.addEventListener('submit',async ev=>{ev.preventDefault();if(!form.reportValidity())return;const b=form.querySelector('button');b.disabled=true;try{await rpc('configure_sports_event',{p_title:form.elements.title.value.trim(),p_open:form.elements.is_open.value==='true',p_deadline:form.elements.deadline.value?new Date(form.elements.deadline.value+':00+03:00').toISOString():null,p_ministry:form.elements.ministry.value});await summary();message('Mipangilio imehifadhiwa.');}catch(e){message(error(e));}finally{b.disabled=false;}});
 }
 async function init(){
  const session=await window.RucusoGuard.requireRole(['super_admin','leader'],{loginUrl:'/admin/login/'});if(!session)return;
  $('sports-viewer').textContent='Umeingia: '+session.profile.full_name+' ('+session.profile.role+').';
  if(!await rpc('can_manage_sports',{})){message('Orodha hii inaonekana kwa Waziri na Naibu wa Michezo na super admin pekee. Katibu hana ruhusa.');return;}
  await summary();for(const s of info.sports){const o=el('option',s.label);o.value=s.code;fields('filter_sport').append(o);}
  $('sports-admin-panel').hidden=false;
  for(const key of ['filter_sport','filter_gender','filter_year'])fields(key).addEventListener('change',()=>load(true).catch(e=>message(error(e))));
  $('roster-refresh').addEventListener('click',()=>Promise.all([summary(),load(true)]).catch(e=>message(error(e))));$('roster-more').addEventListener('click',()=>load(false).catch(e=>message(error(e))));
  $('roster-reset').addEventListener('click',()=>{for(const key of ['filter_sport','filter_gender','filter_course','filter_year'])fields(key).value='';load(true).catch(e=>message(error(e)));});
  $('export-xlsx').addEventListener('click',()=>exportAll('xlsx'));$('export-pdf').addEventListener('click',()=>exportAll('pdf'));
  await load(true);message('Chagua mchezo kuona orodha yake au kupakua Excel / PDF.');
  if(session.profile.role==='super_admin'){
   try{await setupSettings();}catch(e){message('Orodha imepakia, lakini mipangilio ya tukio haijapatikana. '+error(e));}
  }
 }
 init().catch(e=>message(error(e)));
})();
