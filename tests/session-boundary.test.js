const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=f=>fs.readFileSync(f,'utf8');
test('Google authentication without an active staff profile never becomes a staff session',async()=>{
 let logged=0;const appWindow={RucusoAPI:{logAction:async()=>{logged++;}}};vm.runInNewContext(read('js/data.js'),{window:appWindow,console});const D=appWindow.RucusoData;
 const user={id:'student-google',email:'student@example.org'};
 for(const profile of [null,{role:'student',active:true},{role:'super_admin',active:false},{role:'leader',active:true,must_change_password:true}]){
  D.DB.feedback=[{private:true}];D.DB.studentsPage.rows=[{private:true}];await D.setSession({user,profile});assert.equal(D.DB.session,null);assert.equal(D.DB.feedback.length,0);assert.equal(D.DB.studentsPage.rows.length,0);
 }
 assert.equal(logged,0,'student login must not generate staff actions');
 await D.setSession({user:{id:'staff',email:'staff@example.org'},profile:{role:'super_admin',active:true,full_name:'Staff'}});assert.equal(D.DB.session.role,'super_admin');assert.equal(logged,1);
 await D.setSession(null);assert.equal(D.DB.session,null);
});
test('homepage cannot create/delete announcements and filters drafts even for staff',()=>{
 const html=read('index.html'),app=read('js/app.js'),data=read('js/data.js'),client=read('supabase/supabase-client.js');
 assert(!html.includes('annCreateCard'));assert(!html.includes('addAnnouncement('));assert(!app.includes('async function addAnnouncement('));assert(!app.includes('adminRow('));assert(!app.includes('async function removeAnnouncement('));
 assert(app.includes('a.status === "published"'));
 const boot=app.slice(app.indexOf('async function boot()'));assert(!boot.includes('D.loadAdmin()'));
 const refresh=data.slice(data.indexOf('async function refreshAnnouncements()'),data.indexOf('async function saveAnnouncement('));assert(!refresh.includes('listAllAnnouncements'));
 const list=client.slice(client.indexOf('async listAnnouncements()'),client.indexOf('async listAllAnnouncements()'));assert(list.includes('.eq("status", "published")'));assert(list.includes('.lte("publish_date", today)'));
});
test('staff identity switching clears private page rather than showing old account data',async()=>{
 let callback,redirected,cleared=false;
 const API={currentSession:async()=>({user:{id:'admin'},profile:{role:'super_admin',active:true}}),onAuthChange:f=>callback=f};
 const appWindow={RucusoAPI:API,location:{replace:url=>redirected=url}};
 vm.runInNewContext(read('js/auth-guard.js'),{window:appWindow,document:{body:{replaceChildren:()=>cleared=true}}});
 await appWindow.RucusoGuard.requireRole(['super_admin'],{loginUrl:'/admin/login/'});
 callback({user:{id:'admin'}});assert.equal(cleared,false);
 callback({user:{id:'student-google'}});assert.equal(cleared,true);assert.equal(redirected,'/admin/login/');
});
