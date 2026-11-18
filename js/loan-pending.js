(function(){
 'use strict';
 const {$,el,rpc}=window.RucusoCommunity,{normalize,validate,error}=window.RucusoLoanPending;
 const form=$('loan-form'),fields=form.elements,status=$('loan-status');let ready=false;
 function other(){const show=fields.bank.value==='OTHER';$('loan-other-label').hidden=!show;fields.bank_other.disabled=!show;fields.bank_other.required=show;if(!show)fields.bank_other.value='';}
 fields.bank.addEventListener('change',other);other();
 form.addEventListener('submit',async ev=>{ev.preventDefault();if(!ready||!form.reportValidity())return;const p=normalize(fields),issue=validate(p);if(issue){status.textContent=issue;return;}
 const submit=form.querySelector('[type="submit"]');submit.disabled=true;status.textContent='Inawasilisha…';
 try{await rpc('submit_loan_pending_sample',{p_payload:p});form.reset();other();$('loan-receipt').replaceChildren(el('h2','Taarifa zimepokelewa'),el('p','Asante. Kama ulituma taarifa hizi awali, rekodi ya kwanza imehifadhiwa bila kubadilishwa. Hifadhi hii si uthibitisho wa malipo au muda wa kutatuliwa.'));status.textContent='Waziri wa Mikopo na super admin wataweza kuona sample zilizowasilishwa.';}
 catch(e){status.textContent=error(e);if(/REGISTRATION_CLOSED/.test(String(e.message))){ready=false;form.hidden=true;}}
 finally{submit.disabled=false;}});
 rpc('loan_pending_public_info').then(info=>{ready=info?.is_open===true;form.hidden=!ready;status.textContent=ready?'Hakiki taarifa zako, kisha wasilisha mara moja.':'Kupokea sample kumefungwa kwa sasa.';}).catch(e=>{status.textContent=error(e);});
})();
