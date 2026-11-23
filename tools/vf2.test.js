const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const D=fs.mkdtempSync(path.join(os.tmpdir(),'vf2-'));
const staff=[{id:'A',name:'Admin',role:'admin'},{id:'H',name:'Hana HR',role:'hr'},{id:'C',name:'Claude CC',role:'cc'},{id:'I1',name:'Ines',role:'int'},{id:'I2',name:'Ivan',role:'int'},{id:'O',name:'Olivier Ops',role:'ops'},{id:'P',name:'Pacy Poster',role:'ops'}];
let apps=[];const removed=[];const acts=[];
const urgent={rights:p=>({post:p.id==='P',review:false}),allApps:()=>apps,remote:async(u)=>{removed.push(u);return{ok:true,json:async()=>({})}}};
const vf=require(require('path').join(__dirname,'..','server','vflow.js'))({DATA_DIR:D,urgent,staffOf:()=>staff,stateOf:()=>({}),appendActivity:a=>acts.push(a.text),broadcast:()=>{},note:()=>{}});
const S=id=>staff.find(x=>x.id===id);
const T=(id,vid)=>vf.mine(S(id)).tasks.find(v=>v.id===vid);
const throws=async(f,re)=>{try{await f();assert.fail('should refuse')}catch(e){assert.match(e.message,re)}};
(async()=>{
 // grant power: Olivier (ops) gets the Call Center step while Claude is away
 vf.setGrant(S('A'),{uid:'O',key:'cc',on:true});
 assert.ok(acts.some(t=>/gave the power “Call Center step” to Olivier/.test(t)));
 await throws(()=>vf.setGrant(S('H'),{uid:'O',key:'cc',on:true}),/Only Admin/);
 const v=vf.create(S('H'),{title:'Receptionist',need:2}).vac;
 // everyone in the life cycle sees it; only the poster's Approve works
 for(const id of ['H','C','I1','I2','O','P']) assert.ok(T(id,v.id),'task for '+id);
 assert.equal(T('P',v.id).me.ready,true); assert.equal(T('C',v.id).me.ready,false); assert.equal(T('I1',v.id).me.act,'wait');
 assert.equal(T('H',v.id).mineToDelete,true); assert.equal(T('C',v.id).mineToDelete,false);
 await throws(()=>vf.remove(S('C'),v.id),/Only Hana HR/);
 // post with limit 3
 vf.claimPost(S('P'),v.id); vf.posted(S('P'),v.id,'UJ-1','Receptionist',3,Date.now()+864e5);
 assert.equal(T('P',v.id),undefined,'the poster is done: it leaves them');
 apps=[{id:'a1',post:'UJ-1',status:'new',data:{name:'A'}},{id:'a2',post:'UJ-1',status:'new',data:{name:'B'}}];
 assert.equal(T('C',v.id).me.ready,false); assert.match(T('C',v.id).me.why,/2 of 3/);
 assert.equal(T('O',v.id).me.ready,false);
 await throws(()=>vf.callApprove(S('C'),v.id),/limit: 2 of 3/);
 apps.push({id:'a3',post:'UJ-1',status:'new',data:{name:'C'}});
 assert.equal(T('C',v.id).me.ready,true); assert.equal(T('O',v.id).me.ready,true,'the substitute too');
 await throws(()=>vf.callApprove(S('O'),v.id),/3 people haven’t been called/);
 apps.forEach((a,i)=>{a.status='done';a.outcome=i<2?'coming':'no-answer'});
 await vf.callApprove(S('O'),v.id);
 assert.ok(removed.some(u=>u.includes('UJ-1/remove')));
 assert.equal(T('C',v.id),undefined); assert.equal(T('O',v.id),undefined,'Call Center done: it leaves them');
 assert.equal(T('H',v.id).me.ready,true); assert.equal(T('I1',v.id).me.ready,false);
 await throws(()=>vf.complete(S('C'),v.id),/belongs to HR/);
 vf.complete(S('H'),v.id);
 assert.equal(T('I1',v.id).me.ready,true); assert.equal(T('I2',v.id).me.ready,true);
 // a second vacancy: deleted by whoever stated it, the job comes down, the record is kept
 const w=vf.create(S('H'),{title:'Cashier',need:1}).vac; vf.claimPost(S('P'),w.id); vf.posted(S('P'),w.id,'UJ-2','Cashier',1,Date.now()+864e5);
 await vf.remove(S('H'),w.id);
 assert.ok(removed.some(u=>u.includes('UJ-2/remove'))); for(const id of ['H','C','P']) assert.equal(T(id,w.id),undefined);
 const db=JSON.parse(fs.readFileSync(path.join(D,'vflow.json'),'utf8')); assert.equal(db.trash[0].id,w.id); assert.equal(db.trash[0].deleted.name,'Hana HR');
 // the limit-less old way still works (no cap = opens at the first applicant)
 const x=vf.create(S('H'),{title:'Driver'}).vac; vf.posted(S('P'),x.id,'UJ-3','Driver',0,Date.now()+864e5); apps.push({id:'b1',post:'UJ-3',status:'new',data:{}});
 assert.equal(T('C',x.id).me.ready,true);
 // a limit not reached but the post has ended: the Call Center can still go on
 const y=vf.create(S('H'),{title:'Guard'}).vac; vf.posted(S('P'),y.id,'UJ-4','Guard',5,Date.now()-1000); apps.push({id:'c1',post:'UJ-4',status:'new',data:{}});
 assert.equal(T('C',y.id).me.ready,true);
 // Admin takes the HR step from Hana: she keeps her own vacancy (she stated it) but loses HR's Approve
 vf.setGrant(S('A'),{uid:'H',key:'hr',on:false}); vf.setGrant(S('A'),{uid:'O',key:'hr',on:true});
 const g=vf.grantsView(S('A')); const h=g.staff.find(z=>z.id==='H'); assert.equal(h.hr,false); assert.equal(h.set.hr,true); assert.equal(h.set.cc,false);
 // the Urgent hiring room honours the powers too
 assert.deepEqual(vf.powers(S('O')),{post:false,review:true});
 console.log('ALL PASS');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
