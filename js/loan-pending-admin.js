(function(){
 'use strict';
 const {$,el,rpc,date,button}=window.RucusoCommunity,{error}=window.RucusoLoanPending;
 const client=window.RucusoAPI?.client;let offset=0,generation=0,loading=false,exporting=false,currentBank=null;
 const status=text=>$('loan-status').textContent=text;
 function card(row){
  const article=el('article',null,'study-card loan-entry');article.append(el('h2',row.full_name),el('p',`${row.registration_number}\nIndex: ${row.index_number}\nBenki: ${row.bank==='OTHER'?row.bank_other:row.bank}`));
  const account=el('p','Akaunti: '+row.account_masked,'loan-account');let revealed=false;
  const toggle=button('Onyesha akaunti',async()=>{if(revealed){account.textContent='Akaunti: '+row.account_masked;toggle.textContent='Onyesha akaunti';revealed=false;}else{const value=await rpc('reveal_loan_pending_account',{p_id:row.id});account.textContent='Akaunti: '+value;toggle.textContent='Ficha akaunti';revealed=true;}});
  article.append(account,toggle,el('p',date(row.created_at),'study-meta'));return article;
 }
 async function load(reset){
  if(loading&&!reset)return;const ticket=++generation;loading=true;$('loan-more').disabled=true;
  if(reset){offset=0;currentBank=$('loan-bank').value||null;$('loan-list').replaceChildren();}
  try{const result=await rpc('list_loan_pending_samples',{p_bank:currentBank,p_offset:offset,p_accounts:false});if(ticket!==generation)return;
   result.rows.forEach(r=>$('loan-list').append(card(r)));offset+=result.rows.length;$('loan-count').textContent=`Sample ${offset} kati ya ${result.total}.`;$('loan-more').hidden=offset>=result.total;
   if(!result.total)$('loan-list').append(el('p','Hakuna sample katika chaguo hili.','notice'));
  }finally{if(ticket===generation){loading=false;$('loan-more').disabled=false;}}
 }
 let pdfReady;
 async function pdfLibrary(){if(window.jspdf?.jsPDF)return;if(!pdfReady)pdfReady=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';script.onload=resolve;script.onerror=()=>{script.remove();pdfReady=null;reject(new Error('PDF_LIBRARY_UNAVAILABLE'));};document.head.append(script);});await pdfReady;}
 async function download(kind){
  if(exporting)return;exporting=true;$('loan-excel').disabled=$('loan-pdf').disabled=true;
  try{if(kind==='pdf')await pdfLibrary();const bank=currentBank;let rows=[],total=Infinity;
   while(rows.length<total){const page=await rpc('list_loan_pending_samples',{p_bank:bank,p_offset:rows.length,p_accounts:true});total=page.total;if(!page.rows.length)break;rows.push(...page.rows);}
   if(!rows.length){status('Hakuna sample za kupakua katika chaguo hili.');return;}
   const title='Sample za malipo ya mkopo Pending',filter='Benki: '+(bank==='OTHER'?'Nyingine':bank||'Zote');
   if(kind==='pdf')window.RucusoLoanPendingExports.pdf(rows,title,filter).save('rucuso-pending-samples.pdf');
   else{const blob=new Blob([window.RucusoLoanPendingExports.xlsx(rows,title,filter)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='rucuso-pending-samples.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
   status(`Sample ${rows.length} zimepakuliwa. Faili lina taarifa binafsi; lishiriki na wahusika wa ufuatiliaji pekee.`);
  }catch(e){status(/PDF_LIBRARY_UNAVAILABLE/.test(String(e.message))?'PDF haijapakia. Hakiki mtandao au tumia Excel.':error(e));}
  finally{exporting=false;$('loan-excel').disabled=$('loan-pdf').disabled=false;}
 }
 async function settings(){
  const config=await rpc('loan_pending_admin_settings');if(!config)return;
  const result=await client.from('ministries').select('id,name').eq('active',true).order('name');if(result.error)throw result.error;
  const f=$('loan-settings').elements;
  for(const m of result.data.filter(m=>/mikopo|loans/i.test(m.name))){const o=el('option',m.name);o.value=m.id;f.ministry.append(o);}
  f.ministry.value=config.ministry_id;f.is_open.value=String(config.is_open);$('loan-settings-panel').hidden=false;
 }
 $('loan-settings').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;if(!form.reportValidity())return;const b=form.querySelector('[type="submit"]');b.disabled=true;try{await rpc('configure_loan_pending',{p_open:form.elements.is_open.value==='true',p_ministry:form.elements.ministry.value});status('Mipangilio imehifadhiwa.');}catch(err){status(error(err));}finally{b.disabled=false;}});
 $('loan-refresh').addEventListener('click',()=>load(true).catch(e=>status(error(e))));$('loan-more').addEventListener('click',()=>load(false).catch(e=>status(error(e))));
 $('loan-excel').addEventListener('click',()=>download('xlsx'));$('loan-pdf').addEventListener('click',()=>download('pdf'));
 (async()=>{const session=await window.RucusoGuard.requireRole(['super_admin','leader'],{loginUrl:'/admin/login/'});if(!session)return;
 if(!await rpc('can_manage_loan_pending')){status('Huna ruhusa. Sehemu hii ni ya Waziri na Naibu wa Mikopo na super admin pekee.');return;}
 status('Umeingia: '+session.profile.full_name+'.');$('loan-inbox').hidden=false;
 // Inbox must not depend on settings/ministries succeeding.
 try{await load(true);}catch(e){status(error(e));}
 if(session.profile.role==='super_admin')try{await settings();}catch(e){status('Orodha haizuiliwi na mipangilio: '+error(e));}
 })().catch(e=>status(error(e)));
})();
