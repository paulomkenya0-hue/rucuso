// A visible approval entry on the main super-admin dashboard.
(async function () {
  const card=document.getElementById('chatApprovalShortcut');
  const count=document.getElementById('chatPendingCount');
  if(!card||!window.RucusoAPI)return;
  try {
    const session=await window.RucusoAPI.currentSession();
    if(!session?.profile?.active||!window.RucusoGuard.hasPermission(session.profile,'manage_feedback'))return;
    card.hidden=false;
    const r=await window.RucusoAPI.client.from('community_members').select('user_id',{count:'exact',head:true}).eq('status','pending');
    if(r.error)throw r.error;
    count.textContent=`Maombi ${r.count} yanasubiri kuidhinishwa.`;
  }catch(_){count.textContent='Idadi ya maombi haijapatikana. Fungua ukurasa wa kuidhinisha uangalie.';}
})();
