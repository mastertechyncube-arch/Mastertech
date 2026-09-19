const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.MASTERTECH_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'mastertech-db.json');
const ADMIN_PASSWORD = process.env.MASTERTECH_ADMIN_PASSWORD || 'ChangeMe-2468';

const DEMO_LAPTOPS = [
['lap01','Dell Latitude 5420','Dell',16,512,650,'Popular','Reliable business laptop for productivity and professional work.'],
['lap02','Dell Latitude 7490','Dell',16,256,520,'Value','Professional productivity laptop for work and study.'],
['lap03','Dell XPS 13','Dell',16,512,1100,'Premium','Compact premium laptop for developers and professionals.'],
['lap04','HP EliteBook 840 G7','HP',16,512,720,'Business','Premium business notebook with a professional design.'],
['lap05','HP ProBook 450 G8','HP',8,512,590,'Value','Balanced laptop for school, office and everyday tasks.'],
['lap06','HP ZBook Studio','HP',32,1000,1450,'Power','High-performance workstation for demanding creative work.'],
['lap07','MacBook Air M2','Apple',8,256,950,'Popular','Lightweight Apple laptop for everyday productivity.'],
['lap08','MacBook Air M3','Apple',16,512,1350,'New','Modern Apple laptop with excellent efficiency and performance.'],
['lap09','Lenovo ThinkPad T14','Lenovo',16,512,750,'Business','Durable professional laptop built for productivity.'],
['lap10','Lenovo IdeaPad 5','Lenovo',8,512,570,'Value','Affordable all-round laptop for work and study.'],
['lap11','Lenovo ThinkPad X1 Carbon','Lenovo',32,1000,1250,'Premium','Lightweight high-end business laptop.'],
['lap12','Lenovo Legion 5','Lenovo',32,1000,1400,'Performance','Powerful laptop for development, creation and demanding applications.']
].map(x=>({id:x[0],name:x[1],brand:x[2],ram:x[3],storage:x[4],price:x[5],tag:x[6],description:x[7],emoji:'▱'}));
const DEMO_DIGITAL = [
['dig01','Business Proposal Template','template',15,'Template','Professional editable business proposal template.'],
['dig02','Social Media Pack','template',12,'Template','Ready-to-edit social media content templates.'],
['dig03','Invoice Template Bundle','template',10,'Template','Professional invoice templates for small businesses.'],
['dig04','Business Presentation Kit','template',18,'Template','Clean presentation templates for business meetings.'],
['dig05','CV & Resume Pack','template',12,'Template','Modern editable CV and resume templates.'],
['dig06','MasterTech File Manager','software',20,'Software','Productivity utility concept for file organization.'],
['dig07','Invoice Pro','software',25,'Software','Digital invoicing utility concept for small businesses.'],
['dig08','Password Vault Lite','software',18,'Software','Personal organization tool concept for credential management.'],
['dig09','Digital Business Starter Guide','ebook',9,'E-book','A practical guide to establishing a digital business presence.'],
['dig10','Beginner Web Development Guide','ebook',12,'E-book','An introductory guide to modern web development concepts.']
].map(x=>({id:x[0],name:x[1],category:x[2],price:x[3],tag:x[4],description:x[5],emoji:'▤'}));

function initialDb(){ return {catalog:{laptops:DEMO_LAPTOPS,digital:DEMO_DIGITAL},settings:{phone:'+27 777 234 5788',email:'hello@mastertech.com',location:'Zimbabwe / Remote',currency:'$'},orders:[],messages:[]}; }
function loadDb(){ try { const d=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(!d.catalog?.laptops?.length || !d.catalog?.digital?.length) throw new Error('invalid catalog'); return d; } catch { const d=initialDb(); saveDb(d); return d; } }
function saveDb(d){ fs.mkdirSync(path.dirname(DB_FILE),{recursive:true}); fs.writeFileSync(DB_FILE,JSON.stringify(d,null,2)); }
let db=loadDb();
const sessions=new Map();
function json(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});res.end(body);}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6)req.destroy();});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});req.on('error',reject)});}
function token(){return crypto.randomBytes(32).toString('hex');}
function auth(req){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;const t=h.slice(7),s=sessions.get(t);if(!s||s.expires<Date.now()){sessions.delete(t);return null;}return t;}
function safeProduct(p){return {...p,id:String(p.id),name:String(p.name||'').slice(0,160),price:Number(p.price)||0};}
function allProducts(){return [...db.catalog.laptops,...db.catalog.digital];}
function routeProduct(id){return allProducts().find(p=>p.id===id);}
function sendFile(req,res){let rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(rel==='/'||rel==='/index.html')rel='/index.html';const file=path.normalize(path.join(ROOT,rel));if(!file.startsWith(ROOT)||!fs.existsSync(file)||fs.statSync(file).isDirectory())return json(res,404,{error:'Not found'});const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});fs.createReadStream(file).pipe(res);}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const p=u.pathname;
    if(p === '/health' && req.method === 'GET') return json(res,200,{ok:true,service:'mastertech'});
    if(p.startsWith('/api/')){
      if(req.method==='GET'&&p==='/api/catalog') return json(res,200,{catalog:db.catalog,settings:db.settings});
      if(req.method==='GET'&&p==='/api/settings') return json(res,200,{settings:db.settings});
      if(req.method==='POST'&&p==='/api/orders'){
        const b=await readBody(req); if(!b.customer||!Array.isArray(b.items)||!b.items.length)return json(res,400,{error:'Customer and items are required'});
        const order={orderId:'MT-'+Date.now().toString(36).toUpperCase()+'-'+Math.floor(Math.random()*900+100),date:new Date().toISOString(),status:'Pending',customer:b.customer,items:b.items,total:Number(b.total)||0};
        db.orders.unshift(order);saveDb(db);return json(res,201,{order});
      }
      if(req.method==='POST'&&p==='/api/messages'){
        const b=await readBody(req);const msg={id:'MSG-'+Date.now(),date:new Date().toISOString(),...b};db.messages.unshift(msg);saveDb(db);return json(res,201,{message:msg});
      }
      if(req.method==='POST'&&p==='/api/admin/login'){
        const b=await readBody(req);if(String(b.password||'')!==ADMIN_PASSWORD)return json(res,401,{error:'Invalid admin password'});
        const t=token();sessions.set(t,{expires:Date.now()+8*60*60*1000});return json(res,200,{token:t});
      }
      const t=auth(req); if(!t)return json(res,401,{error:'Unauthorized'});
      if(req.method==='POST'&&p==='/api/admin/logout'){sessions.delete(t);return json(res,200,{ok:true});}
      if(req.method==='GET'&&p==='/api/admin/dashboard')return json(res,200,{catalog:db.catalog,settings:db.settings,orders:db.orders,messages:db.messages});
      if(req.method==='POST'&&p==='/api/admin/products'){
        const b=safeProduct(await readBody(req)); if(!b.name)return json(res,400,{error:'Product name is required'});const type=b.type==='laptop'?'laptop':'digital';delete b.type;db.catalog[type]=db.catalog[type].filter(x=>x.id!==b.id);db.catalog[type].push(b);saveDb(db);return json(res,200,{product:b,catalog:db.catalog});
      }
      if(req.method==='DELETE'&&p.startsWith('/api/admin/products/')){const id=decodeURIComponent(p.split('/').pop());db.catalog.laptops=db.catalog.laptops.filter(x=>x.id!==id);db.catalog.digital=db.catalog.digital.filter(x=>x.id!==id);saveDb(db);return json(res,200,{catalog:db.catalog});}
      if(req.method==='PUT'&&p==='/api/admin/settings'){const b=await readBody(req);db.settings={...db.settings,...b};saveDb(db);return json(res,200,{settings:db.settings});}
      if(req.method==='PUT'&&p.startsWith('/api/admin/orders/')){const id=decodeURIComponent(p.split('/').pop());const b=await readBody(req);const o=db.orders.find(x=>x.orderId===id);if(!o)return json(res,404,{error:'Order not found'});if(b.status)o.status=b.status;saveDb(db);return json(res,200,{order:o});}
      return json(res,404,{error:'API route not found'});
    }
    sendFile(req,res);
  }catch(e){console.error(e);json(res,500,{error:'Server error'});}
});
server.listen(PORT,HOST,()=>console.log(`MasterTech v2 running at http://localhost:${PORT}`));
