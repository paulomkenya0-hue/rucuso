const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync('js/study.js', 'utf8');
const sql = fs.readFileSync('supabase/migrations/019_study_hub.sql', 'utf8');
class Element {
  constructor() { this.value = ''; this.children = []; this.events = {}; this.dataset = {}; }
  append(...x) { this.children.push(...x); }
  replaceChildren(...x) { this.children = x; }
  addEventListener(k, fn) { this.events[k] = fn; }
  querySelector() { return this.button ||= new Element(); }
  reportValidity() { return true; }
  reset() { this.didReset = true; }
}
async function setup({admin=false, allowed=true, rows=[]}={}) {
  const nodes = {}, calls = [], rpcCalls = [];
  const get = id => nodes[id] ||= new Element();
  const form = get('study-submit'); form.elements = {};
  for (const k of ['title','course','subject','study_year','semester','kind','source','description','resource_url']) form.elements[k] = new Element();
  Object.entries({title:'Cost notes',course:'BAFIT',subject:'Accounting',study_year:'2',semester:'1',kind:'notes',source:'Own notes',resource_url:'https://example.org/notes.pdf'}).forEach(([k,v]) => form.elements[k].value=v);
  get('study-state').value='pending';
  const client = {
    from(table) {
      calls.push(['from', table]);
      const q = {then(resolve) { resolve({data:rows,error:null}); }};
      for (const name of ['select','eq','order','range','or','ilike','update']) q[name] = (...args) => { calls.push([name,...args]); return q; };
      return q;
    },
    async rpc(name,payload) { rpcCalls.push({name,payload}); return {data:allowed,error:null}; }
  };
  const document = {body:{dataset:{studyAdmin:String(admin)}}, getElementById:get, createElement:()=>new Element()};
  const window = {RucusoAPI:{client},RucusoGuard:{requireRole:async()=>({profile:{role:'admin'}})}};
  vm.runInNewContext(script,{document,window,URL,console,setTimeout,clearTimeout,alert:()=>{}});
  await new Promise(resolve=>setImmediate(resolve));
  return {get,form,calls,rpcCalls};
}
(async()=>{
  const row={id:'1',title:'<img src=x onerror=alert(1)>',course:'BAFIT',subject:'Accounting',study_year:2,semester:1,kind:'notes',source:'Own notes',description:'',resource_url:'javascript:alert(1)'};
  const s=await setup({rows:[row]});
  assert(s.calls.some(c=>c[0]==='eq'&&c[1]==='status'&&c[2]==='approved'));
  assert(s.calls.some(c=>c[0]==='range'&&c[2]===23));
  const card=s.get('study-list').children[0];
  assert.equal(card.children[1].textContent,row.title,'untrusted title must render as text');
  assert.equal(card.children.at(-1).children.length,0,'unsafe URL must not create a link');
  await s.form.events.submit({preventDefault(){}});
  assert.equal(s.rpcCalls[0].name,'submit_study_resource');
  assert.equal(s.rpcCalls[0].payload.p_resource_url,'https://example.org/notes.pdf');
  assert.equal(s.rpcCalls[0].payload.status,undefined,'visitor cannot choose publication status');
  s.form.elements.resource_url.value='http://example.org';
  await s.form.events.submit({preventDefault(){}});
  assert.equal(s.rpcCalls.length,1,'non-HTTPS link must be rejected');
  s.form.elements.kind.value='request';
  await s.form.events.submit({preventDefault(){}});
  assert.equal(s.rpcCalls[1].payload.p_resource_url,null,'requests do not require a link');
  const denied=await setup({admin:true,allowed:false});
  assert.equal(denied.calls.length,0,'unauthorized staff must not load moderation queue');
  assert.equal(denied.rpcCalls[0].payload.p_key,'manage_documents');
  assert(sql.includes('enable row level security'));
  assert(sql.includes("status = 'approved' or public.has_permission('manage_documents')"));
  assert(sql.includes("grant update(status), delete"),'staff cannot rewrite submitted source or URL');
  assert(sql.includes("default 'pending'"));
  assert(sql.includes('pg_advisory_xact_lock'),'queue cap must be atomic');
  assert(!/grant insert.*study_resources/i.test(sql),'public must submit via bounded RPC');
  console.log('Study Hub: publication filtering, safe text/links, submissions, request flow, permission gate and SQL contracts passed');
})().catch(e=>{console.error(e);process.exit(1);});
