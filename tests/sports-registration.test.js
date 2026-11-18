const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const sql=fs.readFileSync('supabase/migrations/021_sports_registration.sql','utf8');
const common=fs.readFileSync('js/community-common.js','utf8');
const exportsCode=fs.readFileSync('js/sports-exports.js','utf8');
class Node{
 constructor(tag='div'){this.tagName=tag;this.value='';this.hidden=true;this.events={};this.children=[];}
 append(...n){this.children.push(...n);}
 replaceChildren(...n){this.children=n;}
 addEventListener(k,f){this.events[k]=f;}
 reportValidity(){return true;}
 querySelector(){return this.button ||= new Node('button');}
 querySelectorAll(){return this.checked||[];}
 click(){this.clicked=true;}
 remove(){}
}
const flush=()=>new Promise(r=>setImmediate(r));
const one={full_name:'Paulo Mkenya Gaitirya',registration_number:'RU/BAFIT/2024/007',phone:'0712345678',course:'BAFIT',study_year:2,gender:'male',sports:['Netball','Volleyball']};
async function setup({admin=false,allowed=true,open=true,error=null,role="leader",settingsFail=false}={}){
 const nodes={},calls=[],blobs=[];const $=id=>nodes[id]||=new Node();
 const fields={};for(const key of ['filter_sport','filter_gender','filter_course','filter_year'])fields[key]=new Node();
 const form=$('sports-form');form.elements={};Object.entries({first_name:'Paulo',middle_name:'Mkenya',last_name:'Gaitirya',registration_number:' ru / bafit / 2024 / 007 ',phone:'0712 345 678',course:'BAFIT',study_year:'2',gender:'male'}).forEach(([k,v])=>{form.elements[k]=new Node();form.elements[k].value=v;});form.checked=[{value:'netball'},{value:'volleyball'}];
 const data=Array.from({length:305},(_,i)=>({...one,id:String(i),full_name:'Student '+i}));
 const info={title:'RUCUSO Sports',is_open:open,total_students:305,sports:[{code:'netball',label:'Netball',count:305},{code:'volleyball',label:'Volleyball',count:1}]};
 const client={from(table){const q={select(){return q;},eq(){return q;},single:async()=>({data:null,error:{message:'Settings unavailable'}}),order:async()=>({data:[],error:null})};return q;},rpc:async(name,args)=>{calls.push({name,args});if(name==='can_manage_sports')return{data:allowed,error:null};if(name==='sports_public_info')return{data:info,error:null};if(name==='sports_roster')return{data:{total:data.length,rows:data.slice(args.p_offset,args.p_offset+args.p_limit)},error:null};if(name==='register_sports')return{data:{reference:'SPORT-123',sports_count:2},error};return{data:null,error:null};}};
 const document={getElementById:$,createElement:t=>new Node(t),querySelector:q=>fields[q.match(/name="([^"]+)/)[1]],body:new Node('body')};
 const window={RucusoAPI:{client},RucusoGuard:{requireRole:async roles=>{calls.push({name:'roles',roles});return{profile:{role,full_name:'Test staff'}};}}};
 const ctx={window,document,TextEncoder,Uint8Array,DataView,Blob,URL:{createObjectURL:b=>{blobs.push(b);return'blob:example';},revokeObjectURL(){}},setTimeout:()=>{},console};
 vm.runInNewContext(common,ctx);vm.runInNewContext(exportsCode,ctx);vm.runInNewContext(fs.readFileSync(admin?'js/sports-admin.js':'js/sports.js','utf8'),ctx);await flush();return{$,fields,calls,form,blobs,window,ctx};
}
(async()=>{
 const s=await setup();assert.equal(s.form.hidden,false);assert.equal(s.$('sports-options').children.length,2);
 await s.form.events.submit({preventDefault(){}});
 const call=s.calls.find(x=>x.name==='register_sports');assert.equal(call.args.p_student.registration_number,'RU/BAFIT/2024/007');assert.equal(call.args.p_student.phone,'0712345678');assert.equal(call.args.p_sports.length,2);assert.equal(s.form.hidden,true);
 const none=await setup();none.form.checked=[];await none.form.events.submit({preventDefault(){}});assert(!none.calls.some(x=>x.name==='register_sports'));
 const closed=await setup({open:false});assert.equal(closed.form.hidden,true);await closed.form.events.submit({preventDefault(){}});assert(!closed.calls.some(x=>x.name==='register_sports'));
 const duplicate=await setup({error:{code:'23505'}});await duplicate.form.events.submit({preventDefault(){}});assert.match(duplicate.$('sports-result').textContent,/tayari imesajiliwa/);
 const denied=await setup({admin:true,allowed:false});assert.equal(denied.$('sports-admin-panel').hidden,true);assert(!denied.calls.some(x=>x.name==='sports_roster'));
 const superWithBrokenSettings=await setup({admin:true,role:'super_admin',settingsFail:true});assert.equal(superWithBrokenSettings.$('sports-roster').children.length,100,'settings failure must not hide saved registrations');assert.match(superWithBrokenSettings.$('sports-admin-status').textContent,/Orodha imepakia/);
 const a=await setup({admin:true});assert.equal(a.$('sports-roster').children.length,100);
 a.fields.filter_sport.value='netball';await a.$('export-xlsx').events.click();assert.equal(a.blobs.length,1);
 const pages=a.calls.filter(x=>x.name==='sports_roster'&&x.args.p_limit===250);assert.deepEqual(pages.map(x=>x.args.p_offset),[0,250]);assert(pages.every(x=>x.args.p_sport==='netball'),'export filters must survive every page');
 const exportsWindow={};vm.runInNewContext(exportsCode,{window:exportsWindow,TextEncoder,Uint8Array,DataView});
 const workbook=exportsWindow.RucusoSportsExports.xlsx([{...one,full_name:'=1+1',course:'Économie & IT'}],'RUCUSO','Netball');assert.equal(new DataView(workbook.buffer).getUint32(0,true),0x04034b50);
 const {spawnSync}=require('node:child_process'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rucuso-xlsx-'));try{const file=path.join(dir,'test.xlsx');fs.writeFileSync(file,workbook);const r=spawnSync('python',['-c',`import openpyxl,sys\nw=openpyxl.load_workbook(sys.argv[1]);s=w.active\nassert s['B4'].value=='=1+1' and s['B4'].data_type=='s'\nassert s['C4'].value=='RU/BAFIT/2024/007'\nassert s['D4'].value=='0712345678'\nassert s['E4'].value=='Économie & IT'\nassert s.freeze_panes=='A4'\nassert s.auto_filter.ref=='A3:H4'`,file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}finally{fs.rmSync(dir,{recursive:true,force:true});}
 // PDF pagination with the same renderer contract, independent of a CDN.
 const pdfCalls=[];class PDF{constructor(){this.pages=1;}setFont(){}setFontSize(){}splitTextToSize(v,w){return String(v).match(new RegExp('.{1,'+Math.max(1,Math.floor(w/2))+'}','g'))||[''];}text(v){pdfCalls.push(v);}addPage(){this.pages++;}setDrawColor(){}line(){}getNumberOfPages(){return this.pages;}setPage(){}}
 exportsWindow.jspdf={jsPDF:PDF};const pdf=exportsWindow.RucusoSportsExports.pdf(Array.from({length:120},()=>one),'Tukio','Netball');assert(pdf.pages>1);assert(pdfCalls.some(x=>typeof x==='string'&&x.includes('Ukurasa')));
 assert(sql.includes("p.role='leader' and p.position='minister'"));assert(sql.includes('e.ministry_id=p.ministry_id'));assert(!sql.includes("p.position in ('minister','deputy_minister'"));
 assert(sql.includes('registration_number text not null unique'));assert(sql.includes('for update;'));assert(sql.includes("if not public.can_manage_sports() then raise exception 'NOT_AUTHORIZED'"));assert(sql.includes("if not public.is_super_admin() then raise exception 'NOT_AUTHORIZED'"));
 assert(!/grant select on public.sports_registrations.*to anon/.test(sql));
 for(const[html,js]of [['sports/index.html','js/sports.js'],['admin/sports/index.html','js/sports-admin.js']]){const markup=fs.readFileSync(html,'utf8');const ids=[...markup.matchAll(/id="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,new Set(ids).size);for(const m of fs.readFileSync(js,'utf8').matchAll(/\$\('([^']+)'\)/g))assert(ids.includes(m[1]),'Missing control '+m[1]);}
 console.log('Sports: multi-choice intake, reg/phone normalization, closed/duplicate intake, minister access, complete filtered export, valid XLSX, safe text and PDF pagination passed');
})().catch(e=>{console.error(e);process.exit(1);});
