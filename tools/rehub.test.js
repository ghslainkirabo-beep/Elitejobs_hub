// Rehub: every account except IT's is removed, records stay, old sign-ins must sign in again,
// Admin's place is kept for the same person, removed accounts can be brought back.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),{spawn}=require('child_process'),crypto=require('crypto');
const D=fs.mkdtempSync(path.join(os.tmpdir(),'rh-'));fs.writeFileSync(path.join(D,'data.json'),JSON.stringify({n:200,virgin:true,empSeq:0,staff:[],tickets:[],calls:[],cands:[{id:'C1',name:'Kept Candidate',role:'Driver',st:'applied'}],ints:[],leaves:[],visitors:[],rooms:[],svc:[],msgs:[],notifs:[],log:[],disabled:{}}));const PORT=18000+Math.floor(Math.random()*900);
const srv=spawn(process.execPath,[path.join(__dirname,'..','server','server.js')],{env:Object.assign({},process.env,{HUB_DATA_DIR:D,PORT:String(PORT)}),stdio:['ignore','pipe','pipe']});
let out='';srv.stdout.on('data',d=>out+=d);srv.stderr.on('data',d=>out+=d);
const dk=()=>crypto.randomBytes(16).toString('hex');
let OK,IT;
async function call(p,body,dev,it){const h={'Content-Type':'application/json','X-Office-Key':OK,'X-Dev-Key':dev||''};if(it)h['X-IT-Key']=IT;const r=await fetch('http://127.0.0.1:'+PORT+p,{method:body===undefined?'GET':'POST',headers:h,body:body===undefined?undefined:JSON.stringify(body)});let j=null;try{j=await r.json()}catch(e){}return{s:r.status,j}}
(async()=>{
 for(let i=0;i<60&&!fs.existsSync(path.join(D,'it-key.txt'));i++)await new Promise(r=>setTimeout(r,100));
 await new Promise(r=>setTimeout(r,400));
 OK=fs.readFileSync(path.join(D,'office-passcode.txt'),'utf8').trim();IT=fs.readFileSync(path.join(D,'it-key.txt'),'utf8').trim();
 const dIT=dk(),dAd=dk(),dHr=dk();
 const it=(await call('/api/register',{name:'Ghislain',role:'it',dev:dIT,fresh:true})).j; assert.ok(it.id,'it registered '+JSON.stringify(it));
 const ad=(await call('/api/register',{name:'Boss Man',role:'admin',dev:dAd,fresh:true})).j; assert.ok(ad.id);
 const hr=(await call('/api/register',{name:'Hana',role:'hr',dev:dHr,fresh:true})).j; assert.ok(hr.id);
 // only real IT on its own device
 assert.equal((await call('/api/it/rehub',undefined,dHr,true)).s,403);
 assert.equal((await call('/api/it/rehub',{confirm:'START FRESH'},dHr,true)).s,400);
 assert.equal((await call('/api/it/rehub',undefined,dIT,false)).s,401);
 const v=(await call('/api/it/rehub',undefined,dIT,true)).j; assert.equal(v.others.length,2);
 assert.match((await call('/api/it/rehub',{confirm:'nope'},dIT,true)).j.error,/START FRESH/);
 const run=(await call('/api/it/rehub',{confirm:'start fresh'},dIT,true)).j; assert.equal(run.removed,2); assert.equal(run.ep,1);
 const after=JSON.parse(fs.readFileSync(path.join(D,'data.json'),'utf8'));
 assert.deepEqual(after.staff.map(x=>x.id),[it.id]); assert.equal(after.cands[0].name,'Kept Candidate'); assert.equal(after.adminReserved,'Boss Man');
 assert.ok(fs.readFileSync(path.join(D,'activity.jsonl'),'utf8').includes('started fresh sign-ins'));
 // an old saved sign-in is refused; IT with the new epoch is fine
 const old=await call('/api/register',{name:'Hana',role:'hr',dev:dHr,ep:0}); assert.equal(old.s,409); assert.match(old.j.error,/started fresh/);
 assert.equal((await call('/api/register',{name:'Ghislain',role:'it',dev:dIT,ep:1})).j.id,it.id);
 // fresh sign-in: new account, new ID; Admin kept for the same person
 const hr2=(await call('/api/register',{name:'Hana',role:'hr',dev:dHr,fresh:true})).j; assert.ok(hr2.id&&hr2.id!==hr.id); assert.equal(hr2.device,'trusted');
 const fake=await call('/api/register',{name:'Somebody',role:'admin',dev:dk(),fresh:true}); assert.equal(fake.s,409); assert.match(fake.j.error,/kept for Boss Man/);
 const ad2=(await call('/api/register',{name:'Boss Man',role:'admin',dev:dAd,fresh:true})).j; assert.ok(ad2.id);
 assert.equal(JSON.parse(fs.readFileSync(path.join(D,'data.json'),'utf8')).adminReserved,undefined);
 // a stale client copy cannot undo the reset
 // bring back from the archive
 const v2=(await call('/api/it/rehub',undefined,dIT,true)).j; assert.equal(v2.past.length,1);
 assert.match((await call('/api/it/rehub/restore',{id:ad.id},dIT,true)).j.error,/already belongs/);
 assert.equal((await call('/api/it/rehub/restore',{id:hr.id},dIT,true)).j.ok,true);
 assert.ok(JSON.parse(fs.readFileSync(path.join(D,'data.json'),'utf8')).staff.some(x=>x.id===hr.id));
 console.log('ALL PASS');
})().catch(e=>{console.error('FAIL',e,'\n',out.slice(-1500));process.exitCode=1}).finally(()=>srv.kill());
