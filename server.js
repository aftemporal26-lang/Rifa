// Servidor sin dependencias: node server.js
// Variables: GMAIL_USER, GMAIL_APP_PASSWORD (contraseña de aplicación), BASE_URL (URL pública, para el enlace Aprobar), NOTIFY_TO, PORT
const http=require('http'),fs=require('fs'),path=require('path'),tls=require('tls');
const PORT=+process.env.PORT||3000, FILE=path.join(__dirname,'numbers.json');
const C={
  user: 'andryphoenix.official@gmail.com', 
  pass: 'hzrddfvklaevwpqr',
  to: 'angierodca@gmail.com',
  base: 'https://rifa-53mv.onrender.com'.replace(/\/$/, '')
};



const free=n=>n&&(n.status==='available'||(n.status==='reserved'&&!n.name&&Date.now()-(n.at||0)>9e5)); // reservas sin pagar vencen a los 15 min
let chain=Promise.resolve();                                   // una escritura a la vez
const lock=fn=>{const r=chain.then(fn);chain=r.catch(()=>{});return r};
const read=()=>JSON.parse(fs.readFileSync(FILE,'utf8'));
const write=L=>{fs.writeFileSync(FILE+'.tmp',JSON.stringify(L,null,2));fs.renameSync(FILE+'.tmp',FILE)};
const pub=L=>L.map(n=>({num:n.num,status:free(n)?'available':n.status,confirm:n.confirm})); // nunca expone nombre, teléfono ni pedido
const err=(m,code)=>Object.assign(new Error(m),{code});

function apply(L,a,p){
  const mine=n=>n.orderId===p.orderId;
  if(a==='reserve'){
    const m=new Map(L.map(n=>[String(n.num),n])),nums=(Array.isArray(p.nums)?p.nums:[]).map(String);
    if(!nums.length||nums.some(x=>!free(m.get(x))))throw err('conflict',409);
    nums.forEach(x=>Object.assign(m.get(x),{status:'reserved',name:'',phone:'',confirm:false,orderId:p.orderId,at:Date.now()}));
  }
  if(a==='release')L.filter(n=>mine(n)&&!n.name).forEach(n=>Object.assign(n,{status:'available',orderId:'',at:0}));
  if(a==='submit')L.filter(mine).forEach(n=>Object.assign(n,{status:'reserved',name:p.name,phone:p.phone,confirm:false}));
  if(a==='approve')L.filter(mine).forEach(n=>Object.assign(n,{status:'unavailable',confirm:true}));
  return L;
}

// ---- Correo por SMTP (Gmail, puerto 465) ----
const b64=s=>Buffer.from(s).toString('base64');
function smtp(raw){
  return new Promise((resolve,reject)=>{
    const s=tls.connect(465,'smtp.gmail.com');let buf='',pend=null;
    const fail=e=>{s.destroy();reject(e)};
    s.setTimeout(30000,()=>fail(new Error('El correo tardó demasiado en enviarse.')));s.on('error',fail);
    const check=()=>{const m=buf.match(/(?:^|\n)(\d{3}) [^\n]*\n$/);if(m&&pend){const p=pend;pend=null;const b=buf;buf='';p(m[1],b)}};
    s.on('data',d=>{buf+=d;check()});
    const rd=code=>new Promise((ok,no)=>{pend=(c,b)=>c===String(code)?ok():no(new Error('SMTP: '+b.trim()));check()});
    const wr=x=>s.write(x+'\r\n');
    (async()=>{
      await rd(220);wr('EHLO localhost');await rd(250);
      wr('AUTH LOGIN');await rd(334);wr(b64(C.user));await rd(334);wr(b64(C.pass));await rd(235);
      wr(`MAIL FROM:<${C.user}>`);await rd(250);wr(`RCPT TO:<${C.to}>`);await rd(250);
      wr('DATA');await rd(354);s.write(raw+'\r\n.\r\n');await rd(250);wr('QUIT');s.end();resolve();
    })().catch(fail);
  });
}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const wrap=s=>s.replace(/.{76}/g,'$&\r\n');
async function mail({name,phone,nums,orderId,receipt}){
  const link=`${C.base}/api/approve?order=${encodeURIComponent(orderId)}`,B='=_b'+Date.now();
  const html=`<div style="font-family:Arial,sans-serif;max-width:480px"><h2>Nuevo pago</h2><p><b>Nombre:</b> ${esc(name)}<br><b>Teléfono:</b> ${esc(phone)}<br><b>Números pagados:</b> ${nums.join(', ')}</p><p>El comprobante va adjunto.</p><p><a href="${link}" style="background:#12182B;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Aprobar</a></p><p style="color:#888;font-size:12px">${link}</p></div>`;
  const raw=[`From: ${C.user}`,`To: ${C.to}`,`Subject: =?UTF-8?B?${b64('Nuevo pago: números '+nums.join(', '))}?=`,'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${B}"`,'',`--${B}`,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',wrap(b64(html)),
    `--${B}`,'Content-Type: image/jpeg; name="comprobante.jpg"','Content-Disposition: attachment; filename="comprobante.jpg"','Content-Transfer-Encoding: base64','',
    wrap(Buffer.from(receipt,'base64').toString('base64')),`--${B}--`].join('\r\n');
  await smtp(raw);
}

// ---- HTTP ----
const send=(res,code,body,type='application/json')=>{res.writeHead(code,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(typeof body==='string'?body:JSON.stringify(body))};
const body=req=>new Promise((ok,no)=>{const d=[];let n=0;
  req.on('data',c=>{n+=c.length;if(n>15e6){no(err('La imagen es demasiado grande.',413));req.destroy()}else d.push(c)});
  req.on('end',()=>{try{ok(JSON.parse(String(Buffer.concat(d))||'{}'))}catch(e){no(err('JSON inválido',400))}});req.on('error',no)});
const page=(t,s)=>`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;text-align:center"><div><h1>${t}</h1><p>${s}</p><a href="/">Ver los números</a></div>`;

async function pay(b){
  if(!C.user||!C.pass)throw err('El servidor no tiene el correo configurado (GMAIL_USER y GMAIL_APP_PASSWORD).',500);
  const name=String(b.name||'').trim(),phone=String(b.phone||'').trim();
  if(name.length<2||phone.replace(/\D/g,'').length<7||!b.receipt||!b.orderId)throw err('Faltan datos: nombre, teléfono o comprobante.',400);
  const nums=(await lock(read)).filter(n=>n.orderId===b.orderId&&n.status==='reserved').map(n=>n.num).sort((a,c)=>a-c);
  if(!nums.length)throw err('Tu reserva venció. Elige tus números otra vez.',409);
  await mail({name,phone,nums,orderId:b.orderId,receipt:b.receipt});   // si el correo falla, no se toca el JSON
  return lock(()=>{const L=apply(read(),'submit',{orderId:b.orderId,name,phone});write(L);return L});
}

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  try{
    if(u.pathname==='/api/numbers'&&req.method==='GET')return send(res,200,pub(await lock(read)));
    if(u.pathname==='/api/numbers'&&req.method==='POST'){
      const b=await body(req);if(!['reserve','release'].includes(b.action))throw err('Acción no permitida',400);
      return send(res,200,pub(await lock(()=>{const L=apply(read(),b.action,b);write(L);return L})));
    }
    if(u.pathname==='/api/pay'&&req.method==='POST')return send(res,200,pub(await pay(await body(req))));
    if(u.pathname==='/api/approve'){
      const id=u.searchParams.get('order')||'';
      const ok=await lock(()=>{const L=read();if(!id||!L.some(n=>n.orderId===id&&n.name))return false;write(apply(L,'approve',{orderId:id}));return true});
      return send(res,ok?200:404,ok?page('Compra aprobada','Los números quedaron como pagados.'):page('Enlace no válido','No encontramos esa compra.'),'text/html');
    }
    const f={'/':'index.html','/index.html':'index.html','/qr.png':'qr.png','/qr.jpg':'qr.jpg'}[u.pathname];
    if(f&&fs.existsSync(path.join(__dirname,f))){
      res.writeHead(200,{'Content-Type':f.endsWith('html')?'text/html; charset=utf-8':f.endsWith('png')?'image/png':'image/jpeg'});
      return res.end(fs.readFileSync(path.join(__dirname,f)));
    }
    send(res,404,'No encontrado','text/plain');
  }catch(e){if(!e.code||e.code>=500)console.error(e);send(res,e.code>=400&&e.code<600?e.code:500,{error:e.message})}
}).listen(PORT,()=>{
  console.log(`Abre ${C.base}`);
  if(!C.user||!C.pass)console.warn('AVISO: falta GMAIL_USER / GMAIL_APP_PASSWORD; los pagos no se podrán enviar.');
});
