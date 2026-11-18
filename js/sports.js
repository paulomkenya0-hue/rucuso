(function(){
 'use strict';
 const {$,el,rpc}=window.RucusoCommunity;
 const form=$('sports-form'),status=$('sports-status');let open=false;
 const normalizeReg=s=>String(s).replace(/\s/g,'').toUpperCase();
 function explain(e){if(e.code==='23505')return 'Reg. number hii tayari imesajiliwa kwenye tukio hili. Wasiliana na Waziri wa Michezo kama unahitaji mabadiliko.';
  if(/REGISTRATION_CLOSED/.test(e.message))return 'Usajili umefungwa.';
  if(/CHOOSE_SPORT|INVALID_SPORT/.test(e.message))return 'Chagua angalau mchezo mmoja kwenye orodha.';
  if(/DAILY_LIMIT/.test(e.message))return 'Usajili wa leo umefikia kikomo. Wasiliana na Wizara ya Michezo.';
  return 'Usajili haujakamilika. Hakiki taarifa na mtandao, kisha jaribu tena.';}
 async function init(){
  const info=await rpc('sports_public_info',{});if(!info)throw new Error('NOT_CONFIGURED');
  $('sports-title').textContent=info.title;open=info.is_open;
  status.textContent=open?`Usajili uko wazi. Wanafunzi ${info.total_students} wameshajisajili.`:'Usajili wa tukio hili umefungwa.';
  if(info.deadline)status.textContent+=' Tarehe ya mwisho: '+new Date(info.deadline).toLocaleString('sw-TZ',{timeZone:'Africa/Dar_es_Salaam'});
  for(const sport of info.sports){const label=el('label',null,'sports-choice');const c=el('input');c.type='checkbox';c.name='sports';c.value=sport.code;label.append(c,el('span',sport.label));$('sports-options').append(label);}
  form.hidden=!open;
 }
 form.elements.registration_number.addEventListener('blur',()=>{form.elements.registration_number.value=normalizeReg(form.elements.registration_number.value);});
 form.addEventListener('submit',async ev=>{
  ev.preventDefault();if(!open||!form.reportValidity())return;
  const result=$('sports-result'),button=form.querySelector('[type="submit"]');
  const sports=[...form.querySelectorAll('[name="sports"]:checked')].map(x=>x.value);
  if(!sports.length){result.textContent='Chagua angalau mchezo mmoja.';return;}
  const student={};for(const key of ['first_name','middle_name','last_name','registration_number','phone','course','study_year','gender'])student[key]=form.elements[key].value.trim();
  student.registration_number=normalizeReg(student.registration_number);student.study_year=Number(student.study_year);student.phone=student.phone.replace(/[\s()-]/g,'');
  if(!/^RU\/[A-Z0-9-]+\/[0-9]{4}\/[0-9]{1,8}$/.test(student.registration_number)){result.textContent='Reg. number iwe kama RU/BAFIT/2024/007.';return;}
  if(!/^\+?[0-9]{9,15}$/.test(student.phone)){result.textContent='Weka namba ya simu sahihi, mfano 0712345678.';return;}
  if(!student.gender){result.textContent='Chagua jinsia yako.';return;}
  button.disabled=true;result.textContent='Inasajili…';
  try{const r=await rpc('register_sports',{p_student:student,p_sports:sports});form.hidden=true;open=false;
   result.replaceChildren(el('h2','Umejisajili kwa mafanikio!'),el('p',`Umechagua michezo ${r.sports_count}. Waziri wa Michezo ataona usajili wako moja kwa moja.`),el('p','Kumbukumbu: '+r.reference,'case-secret'));status.textContent='Usajili wako umepokelewa.';
  }catch(e){result.textContent=explain(e);if(/REGISTRATION_CLOSED/.test(e.message)){open=false;form.hidden=true;status.textContent='Usajili umefungwa.';}}finally{button.disabled=false;}
 });
 init().catch(()=>{status.textContent='Huduma ya usajili haijapatikana. Tafadhali jaribu tena baadaye au wasiliana na RUCUSO.';});
})();
