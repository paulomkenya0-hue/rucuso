const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process');
class Node{
 constructor(tag='div'){this.tagName=tag;this.value='';this.hidden=true;this.children=[];this.events={};}
 append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}addEventListener(k,f){this.events[k]=f;}querySelector(){return this.button ||=new Node('button');}reportValidity(){return true;}reset(){this.didReset=true;}
}
const flush=()=>new Promise(r=>setImmediate(r));
async function setup({admin=false,allowed=true,open=true,role='leader',settingsFail=false}={}){
 const nodes={},calls=[],$=id=>nodes[id]||=new Node();
 $('loan-form').elements={};for(const[k,v]of Object.entries({full_name:' Sample  Student Name ',registration_number:'ru / bafit / 2024 / 007',index_number:'s1234.0001.2024',bank:'CRDB',bank_other:'',account_number:'0152000000001',consent:true})){const n=new Node();n.value=v;n.checked=v===true;$('loan-form').elements[k]=n;}
 const make=i=>({id:'sample-'+i,full_name:'<script>Sample Student</script>',registration_number:'RU/TEST/2024/'+i,index_number:'S1234.0001.2024',bank:'CRDB',account_masked:'••••0001',account_number:null,created_at:'2026-11-18T07:00:00Z'});
 const client={rpc:async(name,args)=>{calls.push({name,args});if(name==='loan_pending_public_info')return{data:{is_open:open}};if(name==='submit_loan_pending_sample')return{data:{received:true}};if(name==='can_manage_loan_pending')return{data:allowed};if(name==='reveal_loan_pending_account')return{data:'0152000000001'};if(name==='list_loan_pending_samples'){const count=args.p_accounts?105:1,offset=args.p_offset,rows=Array.from({length:Math.min(100,count-offset)},(_,i)=>({...make(offset+i),account_number:args.p_accounts?'0152000000001':null}));return{data:{total:count,rows}};}if(name==='loan_pending_admin_settings'&&settingsFail)return{error:{message:'settings failed'}};return{data:null};}};
 let exported;
 const document={getElementById:$,createElement:t=>new Node(t)};
 const window={RucusoAPI:{client},RucusoGuard:{requireRole:async()=>({profile:{role,full_name:'Minister'}})},RucusoLoanPendingExports:{xlsx:rows=>{exported=rows;return new Uint8Array();}}};
 const ctx={window,document,console,Blob,URL:{createObjectURL:()=>'',revokeObjectURL(){}},setTimeout:f=>f()};
 for(const f of ['js/community-common.js','js/loan-pending-common.js',admin?'js/loan-pending-admin.js':'js/loan-pending.js'])vm.runInNewContext(fs.readFileSync(f,'utf8'),ctx);
 await flush();return{$,calls,window,exported:()=>exported};
}
(async()=>{
 const s=await setup(),f=s.$('loan-form'),common=s.window.RucusoLoanPending;assert.equal(f.hidden,false);assert.equal(s.$('loan-other-label').hidden,true);
 await f.events.submit({preventDefault(){}});const p=s.calls.find(c=>c.name==='submit_loan_pending_sample').args.p_payload;
 assert.equal(p.account_number,'0152000000001');assert.equal(p.full_name,'Sample Student Name');assert.equal(p.registration_number,'RU/BAFIT/2024/007');assert.equal(p.index_number,'S1234.0001.2024');assert.deepEqual(Object.keys(p).sort(),['account_number','bank','bank_other','consent','full_name','index_number','registration_number']);
 assert.equal(common.validate({...p,index_number:'P1234.0001.2024'}),'');assert(common.validate({...p,index_number:'S/P1234.0001.2024'}));assert(common.validate({...p,full_name:'Two Names'}));assert(common.validate({...p,account_number:'012X'}));
 f.elements.bank.value='OTHER';f.elements.bank.events.change();assert.equal(s.$('loan-other-label').hidden,false);assert.equal(f.elements.bank_other.required,true);assert.equal(f.elements.bank_other.disabled,false);
 const closed=await setup({open:false});await closed.$('loan-form').events.submit({preventDefault(){}});assert(!closed.calls.some(c=>c.name==='submit_loan_pending_sample'));
 const denied=await setup({admin:true,allowed:false});assert.equal(denied.$('loan-inbox').hidden,true);assert(!denied.calls.some(c=>c.name==='list_loan_pending_samples'));
 const a=await setup({admin:true});const card=a.$('loan-list').children[0];assert.equal(card.children[0].textContent,'<script>Sample Student</script>');assert.equal(card.children[2].textContent,'Akaunti: ••••0001');await card.children[3].events.click();assert.equal(card.children[2].textContent,'Akaunti: 0152000000001');await card.children[3].events.click();assert.equal(card.children[2].textContent,'Akaunti: ••••0001');
 await a.$('loan-excel').events.click();await flush();assert.equal(a.exported().length,105);assert(a.exported().every(r=>r.account_number==='0152000000001'));
 const fail=await setup({admin:true,role:'super_admin',settingsFail:true});assert.equal(fail.$('loan-list').children.length,1);
 for(const[html,js]of [['loan-pending/index.html','js/loan-pending.js'],['admin/loan-pending/index.html','js/loan-pending-admin.js']]){const h=fs.readFileSync(html,'utf8'),j=fs.readFileSync(js,'utf8');const ids=[...h.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);for(const m of j.matchAll(/\$\('([^']+)'\)/g))assert(ids.includes(m[1]),html+' missing '+m[1]);assert(!j.includes('innerHTML'));assert(!j.includes('localStorage'));}
 // Verify real XLSX text cells preserve leading zeros and prevent formula execution.
 const w={};vm.runInNewContext(fs.readFileSync('js/loan-pending-exports.js','utf8'),{window:w,TextEncoder,Uint8Array,DataView});
 const bytes=w.RucusoLoanPendingExports.xlsx([{full_name:'=Sample Student Name',registration_number:'RU/TEST/2024/007',index_number:'P1234.0001.2024',bank:'OTHER',bank_other:'Other Bank',account_number:'0152000000001'}],'Samples','All');
 const parsed=cp.spawnSync(process.env.PYTHON||'python',['-c',`import io,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));r=E.fromstring(z.read('xl/worksheets/sheet1.xml'));ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
cells={c.attrib['r']:c for c in r.findall('.//s:c',ns)}
assert cells['F4'].find('s:is/s:t',ns).text=='0152000000001'
assert cells['B4'].find('s:is/s:t',ns).text=='=Sample Student Name'
assert all(c.attrib['t']=='inlineStr' and c.find('s:f',ns) is None for c in cells.values())`],{input:Buffer.from(bytes),encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);
 console.log('Pending samples: exact intake fields, S/P validation, bank selection, account zeros, closure, access gate, safe text, masked/revealed accounts, independent settings, multi-page export and real XLSX checks passed.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
