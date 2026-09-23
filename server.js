// Servidor simplificado para Render (El correo se envía por Formspree desde el frontend)
// Variables opcionales: PORT, BASE_URL (URL pública de Render para el enlace de aprobación)
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 3000, FILE = path.join(__dirname, 'numbers.json');

const C = {
  base: (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/\$/, '')
};

// Las reservas sin pagar vencen automáticamente a los 15 minutos
const free = n => n && (n.status === 'available' || (n.status === 'reserved' && !n.name && Date.now() - (n.at || 0) > 9e5)); 

let chain = Promise.resolve(); // Asegura una sola escritura al JSON a la vez para evitar corrupción
const lock = fn => { const r = chain.then(fn); chain = r.catch(() => {}); return r };

const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const write = L => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(L, null, 2)); fs.renameSync(FILE + '.tmp', FILE) };
const pub = L => L.map(n => ({ num: n.num, status: free(n) ? 'available' : n.status, confirm: n.confirm })); // Oculta datos privados al público

const err = (m, code) => Object.assign(new Error(m), { code });

function apply(L, a, p) {
  const mine = n => n.orderId === p.orderId;
  if (a === 'reserve') {
    const m = new Map(L.map(n => [String(n.num), n])), nums = (Array.isArray(p.nums) ? p.nums : []).map(String);
    if (!nums.length || nums.some(x => !free(m.get(x)))) throw err('conflict', 409);
    nums.forEach(x => Object.assign(m.get(x), { status: 'reserved', name: '', phone: '', confirm: false, orderId: p.orderId, at: Date.now() }));
  }
  if (a === 'release') L.filter(n => mine(n) && !n.name).forEach(n => Object.assign(n, { status: 'available', orderId: '', at: 0 }));
  if (a === 'submit') L.filter(mine).forEach(n => Object.assign(n, { status: 'reserved', name: p.name, phone: p.phone, confirm: false }));
  if (a === 'approve') L.filter(mine).forEach(n => Object.assign(n, { status: 'unavailable', confirm: true }));
  return L;
}

// Estructura visual para la página de confirmación tras dar clic en "Aprobar"
const page = (t, s) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;text-align:center;background:#F3F5F9;color:#12182B"><div><h1 style="font-size:32px;margin-bottom:8px">${t}</h1><p style="color:#6B7488;font-size:18px;margin-bottom:24px">${s}</p><a href="/" style="background:#12182B;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Regresar a la página</a></div></body>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    // API para que el frontend lea los números disponibles y bloqueados
    if (u.pathname === '/api/numbers' && req.method === 'GET') return send(res, 200, pub(await lock(read)));
    
    // API para apartar números temporalmente o liberarlos
    if (u.pathname === '/api/numbers' && req.method === 'POST') {
      const b = await body(req); if (!['reserve', 'release'].includes(b.action)) throw err('Acción no permitida', 400);
      return send(res, 200, pub(await lock(() => { const L = apply(read(), b.action, b); write(L); return L })));
    }
    
    // API que procesa los datos guardándolos localmente cuando el cliente da clic en "Enviar"
    if (u.pathname === '/api/pay' && req.method === 'POST') {
      const b = await body(req);
      const name = String(b.name || '').trim(), phone = String(b.phone || '').trim();
      if (name.length < 2 || phone.replace(/\D/g,'').length < 7 || !b.orderId) throw err('Faltan datos obligatorios.', 400);
      
      const L = await lock(() => {
        const list = apply(read(), 'submit', b);
        write(list);
        return list;
      });
      return send(res, 200, pub(L));
    }
    
    // Endpoint al que apunta el botón "Aprobar" del correo electrónico de Formspree
    if (u.pathname === '/api/approve') {
      const id = u.searchParams.get('order') || '';
      const ok = await lock(() => {
        const L = read();
        if (!id || !L.some(n => n.orderId === id && n.name)) return false;
        write(apply(L, 'approve', { orderId: id }));
        return true;
      });
      return send(res, ok ? 200 : 404, ok ? page('Compra Aprobada ✅', 'Los números asignados han quedado bloqueados como ocupados permanentemente.') : page('Enlace Inválido ❌', 'No se encontró ninguna orden pendiente asociada a este enlace.'), 'text/html');
    }
    
    // Servidor de archivos estáticos básicos
    const f = { '/': 'index.html', '/index.html': 'index.html', '/qr.png': 'qr.png', '/qr.jpg': 'qr.jpg' }[u.pathname];
    if (f && fs.existsSync(path.join(__dirname, f))) {
      res.writeHead(200, { 'Content-Type': f.endsWith('html') ? 'text/html; charset=utf-8' : f.endsWith('png') ? 'image/png' : 'image/jpeg' });
      return res.end(fs.readFileSync(path.join(__dirname, f)));
    }
    send(res, 404, 'No encontrado', 'text/plain');
  } catch (e) { 
    if (!e.code || e.code >= 500) console.error(e); 
    send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); 
  }
}).listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) };
const body = req => new Promise((ok, no) => { const d = []; let n = 0; req.on('data', c => { n += c.length; if (n > 15e6) { no(err('Archivo demasiado grande.', 413)); req.destroy() } else d.push(c) }); req.on('end', () => { try { ok(JSON.parse(String(Buffer.concat(d)) || '{}')) } catch (e) { no(err('JSON inválido', 400)) } }); req.on('error', no) });
