const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const D=fs.mkdtempSync(path.join(os.tmpdir(),'t3-'));const now=Date.now();
fs.writeFileSync(path.join(D,'urgent-apps.json'),JSON.stringify([
 {id:'a',post:'X',created:now-864e5,data:{name:'Aline Uwase',phone:'0788000001',position:'Driver',experience:'3 years driving a truck, category C licence',lives:'Remera, Gasabo',gender:'f',files:['cv']}},
 {id:'b',post:'X',created:now-864e5,data:{name:'Eric Mugisha',phone:'0788000002',position:'Driver',experience:'Moto taxi',lives:'Huye',gender:'m'}},
 {id:'c',post:'Y',created:now-864e5,data:{name:'Diane Ingabire',phone:'0788000003',position:'Waiter',experience:'Hotel restaurant',lives:'Kicukiro'}}]));
fs.writeFileSync(path.join(D,'vflow.json'),JSON.stringify({vacs:[{id:'V1',title:'Driver',stage:'post',created:now,loc:'Gasabo',reqs:'Category C licence required\nSpeaks English',rules:{gender:'f',cv:true}}]}));
const M=require(path.join(__dirname,'..','server','match.js'))({DATA_DIR:D,rightsOf:()=>({view:true})});
const r=M.suggest({id:'u'},{vac:'V1'});
assert.equal(r.total,1); const a=r.list[0]; assert.equal(a.name,'Aline Uwase');
const st=id=>a.checks.find(c=>c.id===id).st;
assert.equal(st('pos'),'met'); assert.equal(st('r0'),'met'); assert.equal(st('r1'),'verify'); assert.equal(st('g'),'met'); assert.equal(st('cv'),'met'); assert.equal(st('loc'),'met');
assert.equal(a.score,Math.max(1,Math.min(99,a.parts.reduce((s,p)=>s+p.pts,0))),'the score is the visible sum');
assert.equal(r.near[0].name,'Eric Mugisha'); assert.ok(r.near[0].fails.includes('g'));
const r2=M.suggest({id:'u'},{title:'Waiter'}); assert.equal(r2.list[0].name,'Diane Ingabire');
// nobody meets every must-have → which requirement to relax
fs.writeFileSync(path.join(D,'vflow.json'),JSON.stringify({vacs:[{id:'V2',title:'Driver',stage:'post',created:now,rules:{gender:'m'},reqs:''}]}));
{const A=JSON.parse(fs.readFileSync(path.join(D,'urgent-apps.json')));A[1].data.gender='f';fs.writeFileSync(path.join(D,'urgent-apps.json'),JSON.stringify(A));}
const r3=M.suggest({id:'u'},{vac:'V2'}); assert.equal(r3.total,0); assert.equal(r3.relax.id,'g'); assert.equal(r3.relax.n,2);
// CV drop
const cvs=require(path.join(__dirname,'..','server','cvs.js'))({DATA_DIR:D,urgent:{allApps:()=>[]},appendActivity:()=>{}});
(async()=>{
 const txt='JEAN PAUL HABIMANA\nKigali, Rwanda · +250 788 123 456 · jp@example.com\nProfile\nReliable driver with 5 years experience.\nSkills\nDriving, Mechanics, Customer care\nLanguages\nKinyarwanda, English\nExperience\nDriver at Volcano Express 2019-2024\nEducation\nA2 Mechanics, IPRC Kigali';
 const d=await cvs.drop({id:'u',role:'hr',name:'HR'},{name:'cv.txt',b64:Buffer.from(txt).toString('base64')});
 assert.equal(d.name,'Jean Paul Habimana'); assert.equal(d.phone,'+250788123456'); assert.equal(d.email,'jp@example.com');
 assert.deepEqual(d.sections.skills,['Driving','Mechanics','Customer care']); assert.equal(d.sections.experience[0],'Driver at Volcano Express 2019-2024');
 const img=await cvs.drop({id:'u',role:'hr',name:'HR'},{name:'cv.jpg',b64:Buffer.from('xx').toString('base64')}); assert.equal(img.image,true);
 console.log('ALL PASS');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
// people: one history, checks with consent, placement + care reminders, CSV import with duplicates caught
(async()=>{ await new Promise(r=>setTimeout(r,50));
 const cvs=require(path.join(__dirname,'..','server','cvs.js'))({DATA_DIR:D,urgent:{allApps:()=>JSON.parse(fs.readFileSync(path.join(D,'urgent-apps.json')))},appendActivity:()=>{}});
 const HR={id:'h',role:'hr',name:'Hana'};
 const im=cvs.importCsv(HR,{csv:'Name,Phone,Position,District\nAline Uwase,0788000001,Driver,Gasabo\nNew Person,0788 999 888,Cleaner,Kicukiro\nbad row,,x\n',from:'old.xlsx'});
 assert.deepEqual(im,{added:1,dup:1,bad:1});
 const h=cvs.history(HR,'p788000001'); assert.ok(h.events.some(e=>e.k==='apply'));
 await assert.rejects(async()=>cvs.verify(HR,{key:'p788000001',item:'id',on:true}),/consent/);
 cvs.verify(HR,{key:'p788000001',consent:true}); const v=cvs.verify(HR,{key:'p788000001',item:'id',on:true}); assert.ok(v.checks.find(x=>x.k==='id').done);
 const pl=cvs.place(HR,{key:'p788000001',employer:'Serena',title:'Driver',start:'1 Dec'}); assert.equal(pl.places.length,1);
 const db=JSON.parse(fs.readFileSync(path.join(D,'people.json')));db.by.p788000001.places[0].t-=8*864e5;fs.writeFileSync(path.join(D,'people.json'),JSON.stringify(db));
 const RM=require(path.join(__dirname,'..','server','reminders.js'))({DATA_DIR:D,urgent:{allApps:()=>[],rights:()=>({}),remote:async()=>({json:async()=>({posts:[]})})},inquiries:{me:()=>({rooms:{}})},appendActivity:()=>{},broadcast:()=>{}});
 const L=await RM.build(HR); assert.ok(JSON.stringify(L).includes('Check in: Driver at Serena'), JSON.stringify(L).slice(0,300));
 cvs.care(HR,{key:'p788000001',id:pl.places[0].id,left:true,why:'Moved to Huye',replace:true});
 assert.ok(JSON.stringify(await RM.build(HR)).includes('Find a replacement for Serena'));
 assert.ok(cvs.search(HR,'New Person').people.length===1);
 console.log('PEOPLE PASS');
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
