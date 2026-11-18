const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
class Node{
 constructor(tag='div'){this.tagName=tag;this.value='';this.hidden=true;this.children=[];this.events={};this.attrs={};}
 append(...n){this.children.push(...n);}
 replaceChildren(...n){this.children=n;}
 addEventListener(k,f){this.events[k]=f;}
 setAttribute(k,v){this.attrs[k]=v;}
 closest(){return this.label ||= new Node('label');}
 querySelector(){return this.button ||=new Node('button');}
 reportValidity(){return true;}
 reset(){this.didReset=true;}
}
const flush=()=>new Promise(r=>setImmediate(r));
async function setup({admin=false,allowed=true,verifiedRoles=[],open=true}={}){
 const nodes={},calls=[];const $=id=>nodes[id]||=new Node();const filters={};for(const k of ['ed_kind','ed_status','ed_course','ed_year'])filters[k]=new Node();
 for(const[id,values]of Object.entries({'education-form':{sender_role:'student',full_name:'Test Student',registration_number:'ru / bafit / 2024 / 007',course:'BAFIT',study_year:'2',phone:'0712 345 678',role_scope:'Class A',kind:'complaint',category:'teaching',title:'<img src=x>',description:'Test educational concern.',solution:'Improve teaching',evidence_url:''},'education-track':{reference:'EDU-123',token:'12345678-1234-1234-1234-123456789abc'}})){$(id).elements={};for(const[k,v]of Object.entries(values)){$(id).elements[k]=new Node();$(id).elements[k].value=v;}}
 const fake={id:'case-1',reference:'EDU-123',sender_role:'cr',role_verified:false,full_name:'Test Student',registration_number:'RU/BAFIT/2024/007',course:'BAFIT',study_year:2,phone:'0712345678',role_scope:'Class A',kind:'complaint',category:'teaching',title:'<img src=x>',description:'<script>never execute</script>',status:'submitted',created_at:'2026-11-18T07:00:00Z'};
 const client={rpc:async(name,args)=>{calls.push({name,args});if(name==='education_public_info')return{data:{title:'RUCU Elimu',is_open:open},error:null};if(name==='education_identity')return{data:{account_id:null,roles:verifiedRoles},error:null};if(name==='can_manage_education')return{data:allowed,error:null};if(name==='submit_education_feedback')return{data:{reference:'EDU-123',tracking_token:'12345678-1234-1234-1234-123456789abc',role_verified:false},error:null};if(name==='list_education_feedback')return{data:{total:1,rows:[fake]},error:null};if(name==='track_education_feedback')return{data:null,error:null};return{data:null,error:null};}};
 const document={getElementById:$,createElement:t=>new Node(t),querySelector:q=>filters[q.match(/name="([^"]+)/)[1]]};
 const window={RucusoAPI:{client},RucusoGuard:{requireRole:async()=>({profile:{role:'leader',full_name:'Minister'}})}};
 const ctx={window,document,URL,console,location:{origin:'https://rucuso.online'}};
 for(const f of ['js/community-common.js','js/education-common.js',admin?'js/education-admin.js':'js/education.js'])vm.runInNewContext(fs.readFileSync(f,'utf8'),ctx);
 await flush();return{$,calls,filters};
}
(async()=>{
 const s=await setup();assert.equal(s.$('education-form').hidden,false);
 const f=s.$('education-form');assert.equal(s.$('education-scope-label').hidden,true);
 f.elements.sender_role.value='cr';f.elements.sender_role.events.change();assert.equal(s.$('education-scope-label').hidden,false);assert.equal(f.elements.role_scope.required,true);assert.match(s.$('education-role-note').textContent,/bado hakijathibitishwa/);
 await f.events.submit({preventDefault(){}});const submit=s.calls.find(c=>c.name==='submit_education_feedback').args.p_payload;assert.equal(submit.sender_role,'cr');assert.equal(submit.registration_number,'RU/BAFIT/2024/007');assert.equal(submit.phone,'0712345678');assert(!Object.hasOwn(submit,'role_verified'));assert(!Object.hasOwn(submit,'status'));assert(!Object.hasOwn(submit,'ministry_id'));
 assert(s.$('education-receipt').children.some(n=>n.textContent==='12345678-1234-1234-1234-123456789abc'));
 const closed=await setup({open:false});await closed.$('education-form').events.submit({preventDefault(){}});assert(!closed.calls.some(c=>c.name==='submit_education_feedback'));
 const denied=await setup({admin:true,allowed:false});assert.equal(denied.$('education-inbox').hidden,true);assert(!denied.calls.some(c=>c.name==='list_education_feedback'));
 const admin=await setup({admin:true});const card=admin.$('education-list').children[0];assert.equal(card.children[1].textContent,'<img src=x>');assert(card.children.some(n=>n.textContent==='<script>never execute</script>'));
 const reply=card.children.at(-1);reply.children[0].value='in_progress';reply.children[1].value='Tunafuatilia.';await reply.events.submit({preventDefault(){}});assert(admin.calls.some(c=>c.name==='reply_education_feedback'&&c.args.p_id==='case-1'&&c.args.p_reply==='Tunafuatilia.'));
 await admin.$('education-tabs').children[2].events.click();assert.equal(admin.calls.filter(c=>c.name==='list_education_feedback').at(-1).args.p_role,'cr');
 for(const[html,js]of [['education/index.html','js/education.js'],['admin/education/index.html','js/education-admin.js']]){const h=fs.readFileSync(html,'utf8'),j=fs.readFileSync(js,'utf8'),ids=[...h.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,new Set(ids).size);for(const m of j.matchAll(/\$\('([^']+)'\)/g))assert(ids.includes(m[1]),html+' missing '+m[1]);assert(!j.includes('innerHTML'));}
 console.log('Education: unverified role labels, normalized intake, server-controlled verification, closed form, private inbox, safe text, role filters, and replies passed.');
})().catch(e=>{console.error(e);process.exit(1);});
