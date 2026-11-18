const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Node{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events={};this.hidden=true;this.value='';}
  append(...n){this.children.push(...n);}
  replaceChildren(...n){this.children=n;}
  addEventListener(k,f){this.events[k]=f;}
  querySelectorAll(){return this.children.filter(n=>n.tagName==='button');}
}
const flush=()=>new Promise(r=>setImmediate(r));
async function setup(allowed){
  const nodes={},calls=[];const $=id=>nodes[id]||=new Node();$('approval-state').value='pending';
  const record={user_id:'student-id',display_name:'<img src=x>',programme:'BAFIT',study_year:2,registration_number:'RU/BAFIT/2024/007',status:'pending'};
  const client={
    from(table){let state=null,count=false;const q={select(cols,opts){count=!!opts?.head;return q;},eq(k,v){state=v;return q;},order(){return q;},range(){return q;},then(resolve){resolve({data:count?null:(record.status===state?[record]:[]),count:record.status===state?1:0,error:null});}};return q;},
    async rpc(name,args){calls.push({name,args});if(name==='can_moderate_community')return{data:allowed,error:null};if(name==='moderate_community_member')record.status=args.p_status;return{data:null,error:null};}
  };
  const window={RucusoAPI:{client},RucusoGuard:{requireRole:async()=>({profile:{role:'super_admin'}})}};
  const document={getElementById:$,createElement:t=>new Node(t)};
  const ctx={window,document,console};vm.runInNewContext(fs.readFileSync('js/community-common.js','utf8'),ctx);vm.runInNewContext(fs.readFileSync('js/admin-chat.js','utf8'),ctx);await flush();return{$,calls,record};
}
(async()=>{
  const denied=await setup(false);assert.equal(denied.$('approval-panel').hidden,true);assert.equal(denied.$('approval-list').children.length,0);
  const s=await setup(true);assert.equal(s.$('approval-panel').hidden,false);
  const card=s.$('approval-list').children[0];assert.equal(card.children[0].textContent,'<img src=x>');
  const approve=card.children.at(-1).children.find(n=>n.textContent==='Approve / Ruhusu kuingia');assert(approve,'approval action must be visible on each pending member');
  await approve.events.click();assert.equal(s.record.status,'approved');
  assert(s.calls.some(c=>c.name==='moderate_community_member'&&c.args.p_user==='student-id'&&c.args.p_status==='approved'));
  assert.equal(s.$('approval-count').textContent,'Maombi 0 yanasubiri kuidhinishwa.');
  assert.match(s.$('approval-status').textContent,/ameruhusiwa/);
  const dashboard=fs.readFileSync('admin/dashboard/index.html','utf8');assert(dashboard.includes('id="chatApprovalShortcut"'));assert(dashboard.includes('href="/admin/chat/"'));assert(dashboard.includes('/js/admin-chat-shortcut.js'));
  const html=fs.readFileSync('admin/chat/index.html','utf8'),code=fs.readFileSync('js/admin-chat.js','utf8');const ids=[...html.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,new Set(ids).size);for(const m of code.matchAll(/\$\('([^']+)'\)/g))assert(ids.includes(m[1]),'Missing admin chat control: '+m[1]);
  console.log('Chat approvals: dashboard entry, denied access, pending member, safe name, approval RPC and updated count passed');
})().catch(e=>{console.error(e);process.exit(1);});
