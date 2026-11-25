// The move to the cloud goes in small parts (Cloudflare's free plan refuses uploads over 100 MB).
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),{spawn}=require('child_process'),crypto=require('crypto');
const O=fs.mkdtempSync(path.join(os.tmpdir(),'mo-')),C=fs.mkdtempSync(path.join(os.tmpdir(),'mc-'));
const PO=19000+Math.floor(Math.random()*400),PC=PO+500,CODE='ABCDEFGH23456789';
fs.writeFileSync(path.join(O,'data.json'),JSON.stringify({n:200,virgin:true,empSeq:1,staff:[{id:'ELR-0001',name:'Ghislain',role:'it',dept:'IT Support',joined:1,last:1}],tickets:[],calls:[],cands:[{id:'C1',name:'Kept'}],ints:[],leaves:[],visitors:[],rooms:[],svc:[],msgs:[],notifs:[],log:[],disabled:{}}));
fs.mkdirSync(path.join(O,'urgent-photos'));const big=crypto.randomBytes(20*1024*1024);fs.writeFileSync(path.join(O,'urgent-photos','big.jpg'),big);
for(let i=0;i<300;i++)fs.writeFileSync(path.join(O,'urgent-photos','p'+i+'.jpg'),crypto.randomBytes(30000+i));
const run=(D,P,env)=>{const p=spawn(process.execPath,[path.join(__dirname,'..','server','server.js')],{env:Object.assign({},process.env,{HUB_DATA_DIR:D,PORT:String(P),HUB_MOVE_TEST:'1'},env),stdio:['ignore','pipe','pipe']});p.log='';p.stdout.on('data',d=>p.log+=d);p.stderr.on('data',d=>p.log+=d);return p};
const office=run(O,PO,{}),cloud=run(C,PC,{HUB_RESTORE_CODE:CODE});
let parts=0;
(async()=>{
 await new Promise(r=>setTimeout(r,1500));
 const IT=fs.readFileSync(path.join(O,'it-key.txt'),'utf8').trim(),OK=fs.readFileSync(path.join(O,'office-passcode.txt'),'utf8').trim();
 const r=await fetch('http://127.0.0.1:'+PO+'/api/it/move',{method:'POST',headers:{'Content-Type':'application/json','X-Office-Key':OK,'X-IT-Key':IT},body:JSON.stringify({to:'http://127.0.0.1:'+PC,code:CODE,who:'Ghislain'})});
 const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));assert.equal(j.ok,true);
 await new Promise(r=>setTimeout(r,800));
 assert.ok(Buffer.compare(fs.readFileSync(path.join(C,'urgent-photos','big.jpg')),big)===0,'big file arrived whole');
 assert.equal(fs.readdirSync(path.join(C,'urgent-photos')).length,301);
 assert.equal(JSON.parse(fs.readFileSync(path.join(C,'data.json'))).cands[0].name,'Kept');
 assert.equal(fs.readFileSync(path.join(C,'it-key.txt'),'utf8').trim(),IT);
 const done=JSON.parse(fs.readFileSync(path.join(C,'restore-done.json')));assert.equal(done.files,fs.readdirSync(O).length>0?done.files:0);
 const act=fs.readFileSync(path.join(O,'activity.jsonl'),'utf8');parts=+(/(\d+) parts/.exec(act)||[])[1];assert.ok(parts>=4,'sent in '+parts+' parts');
 console.log('ALL PASS ('+done.files+' files in '+parts+' parts)');
})().catch(e=>{console.error('FAIL',e,'\nOFFICE',office.log.slice(-800),'\nCLOUD',cloud.log.slice(-800));process.exitCode=1}).finally(()=>{office.kill();cloud.kill()});
