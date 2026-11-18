/* Shared helpers: no untrusted values enter innerHTML. */
(function () {
  const labels = {submitted:'Imepokelewa',in_progress:'Inashughulikiwa',waiting:'Inasubiri taarifa',resolved:'Imetatuliwa',closed:'Imefungwa',pending:'Inasubiri ukaguzi',approved:'Imeruhusiwa',suspended:'Imesimamishwa',rejected:'Imekataliwa'};
  const $ = id => document.getElementById(id);
  function el(tag,text,cls) { const n=document.createElement(tag); if(text!=null)n.textContent=text; if(cls)n.className=cls; return n; }
  function date(value) { return value ? new Date(value).toLocaleString('sw-TZ',{timeZone:'Africa/Dar_es_Salaam'}) : '—'; }
  function error(e) {
    const raw=String(e?.message||e||'')+' '+String(e?.code||'');
    if(/DAILY_LIMIT|HOURLY_LIMIT|SLOW_DOWN/.test(raw)) return 'Umetuma maombi mengi. Subiri kabla ya kujaribu tena.';
    if(/NOT_AUTHORIZED|AUTH_REQUIRED|42501/.test(raw)) return 'Huna ruhusa kwa hatua hii. Hakiki hali ya akaunti yako.';
    if(/INVALID_RESIDENCE/.test(raw)) return 'Chagua hostel sahihi au andika eneo la off-campus.';
    if(/FUTURE_DATE/.test(raw)) return 'Tarehe ya tukio haiwezi kuwa ya baadaye.';
    if(/ALREADY_APPLIED/.test(raw)) return 'Ombi lako la kujiunga tayari lipo. Angalia hali yake.';
    if(/Unsupported provider|provider is not enabled|provider.*not enabled/i.test(raw)) return 'Google login bado haijawashwa. Msimamizi aiunganishe kwenye Supabase.';
    if(/Invalid login credentials|Email not confirmed/.test(raw)) return 'Email au password si sahihi, au email bado haijathibitishwa.';
    if(/42P01|PGRST20[25]|schema cache|does not exist/.test(raw+' '+e?.code)) return 'Huduma hii haijawashwa kikamilifu kwenye database. Msimamizi ahakiki migration ya sehemu hii.';
    return 'Hatua haijakamilika. Hakiki taarifa na mtandao, kisha jaribu tena.';
  }
  async function rpc(name,args) { if(!window.RucusoAPI)throw new Error('NOT_CONFIGURED'); const r=await window.RucusoAPI.client.rpc(name,args);if(r.error)throw r.error;return r.data; }
  function button(text,handler,cls='btn btn--ghost') { const n=el('button',text,cls);n.type='button';n.addEventListener('click',async()=>{n.disabled=true;try{await handler();}catch(e){alert(error(e));}finally{n.disabled=false;}});return n; }
  window.RucusoCommunity={$,el,date,error,rpc,button,labels};
})();
