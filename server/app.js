// HTTP API + static front end. The browser does all the video work; this server keeps accounts,
// projects (as JSON) and the keys for Claude, ElevenLabs and Stripe.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, COSTS } from './config.js';
import { db, now, saldo, registrarUso, inicioMes } from './db.js';
import { hashPass, checkPass, abrirSesion, cerrarSesion, usuarioDe, conSesion, soloAdmin, limitar, publico, PERFIL_BASE } from './auth.js';
import * as ai from './ai.js';
import * as billing from './billing.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(aqui, '..', 'public');
const fallo = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const texto = (v, max) => String(v ?? '').trim().slice(0, max);

export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  });
  if (cfg.production) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- Stripe webhook: needs the raw body, so it is mounted before the JSON parser ---------- */
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!cfg.hasBilling) return res.status(404).end();
  if (!billing.firmaValida(req.body, req.get('stripe-signature'), cfg.stripe.webhookSecret)) return res.status(400).end();
  try { billing.recibirEvento(JSON.parse(req.body.toString('utf8'))); } catch (e) { console.error('[stripe] webhook', e); return res.status(400).end(); }
  res.json({ received: true });
});

/* ---------- API guard: a custom header on every write blocks cross-site form posts ---------- */
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'estudio') return fallo(res, 403, 'forbidden', 'Petición no permitida.');
  next();
});
const audio = express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '80mb' });
app.use('/api', express.json({ limit: '40mb' }));

app.get('/api/config', (req, res) => res.json({
  ia: cfg.hasAI, demo: cfg.aiMock, transcripcion: cfg.hasSTT, pagos: cfg.hasBilling,
  registro: cfg.signupMode === 'closed' && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 ? 'open' : cfg.signupMode,
  planes: cfg.plans, costes: COSTS, perfilBase: PERFIL_BASE,
}));

/* ---------- accounts ---------- */
const yo = u => ({ user: publico(u), saldo: saldo(u) });

app.post('/api/auth/signup', limitar(8, 15 * 60e3), (req, res) => {
  const email = texto(req.body?.email, 200).toLowerCase(), pass = String(req.body?.pass ?? ''), nombre = texto(req.body?.nombre, 60);
  const primero = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if (cfg.signupMode === 'closed' && !primero) return fallo(res, 403, 'signup_closed', 'El registro está cerrado. Pide acceso a la administradora.');
  if (cfg.signupMode === 'invite' && texto(req.body?.codigo, 100) !== cfg.inviteCode) return fallo(res, 403, 'bad_invite', 'El código de invitación no es correcto.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fallo(res, 400, 'bad_email', 'Escribe un correo válido.');
  if (pass.length < 8) return fallo(res, 400, 'weak_pass', 'La contraseña necesita al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fallo(res, 409, 'exists', 'Ya hay una cuenta con ese correo. Inicia sesión.');
  const admin = cfg.adminEmail ? email === cfg.adminEmail : primero;
  const r = db.prepare('INSERT INTO users (email, nombre, pass, rol, plan, creado) VALUES (?,?,?,?,?,?)').run(email, nombre, hashPass(pass), admin ? 'admin' : 'user', admin ? 'pro' : 'free', now());
  abrirSesion(res, Number(r.lastInsertRowid));
  res.json(yo(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid))));
});

app.post('/api/auth/login', limitar(10, 10 * 60e3), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(texto(req.body?.email, 200).toLowerCase());
  if (!u || !checkPass(String(req.body?.pass ?? ''), u.pass)) return fallo(res, 401, 'bad_login', 'Correo o contraseña incorrectos.');
  abrirSesion(res, u.id);
  res.json(yo(u));
});
app.post('/api/auth/logout', (req, res) => { cerrarSesion(req, res); res.json({ ok: true }); });

app.get('/api/me', (req, res) => { const u = usuarioDe(req); res.json(u ? yo(u) : { user: null }); });
app.put('/api/me', conSesion, (req, res) => {
  const b = req.body || {}, p = b.perfil || {};
  const perfil = { nicho: texto(p.nicho, 120) || PERFIL_BASE.nicho, tono: texto(p.tono, 300) || PERFIL_BASE.tono, idioma: texto(p.idioma, 30) || PERFIL_BASE.idioma };
  db.prepare('UPDATE users SET nombre = ?, perfil = ? WHERE id = ?').run(texto(b.nombre, 60), JSON.stringify(perfil), req.user.id);
  res.json(yo(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});
app.put('/api/me/password', conSesion, limitar(8, 15 * 60e3), (req, res) => {
  const nueva = String(req.body?.nueva ?? '');
  if (!checkPass(String(req.body?.actual ?? ''), req.user.pass)) return fallo(res, 401, 'bad_login', 'La contraseña actual no es correcta.');
  if (nueva.length < 8) return fallo(res, 400, 'weak_pass', 'La contraseña necesita al menos 8 caracteres.');
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(nueva), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  abrirSesion(res, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/me', conSesion, (req, res) => {
  if (!checkPass(String(req.body?.pass ?? ''), req.user.pass)) return fallo(res, 401, 'bad_login', 'La contraseña no es correcta.');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  cerrarSesion(req, res);
  res.json({ ok: true });
});

/* ---------- projects (state only: the media stays in the browser) ---------- */
const TIPOS = ['video', 'clips'];
const resumen = p => ({ id: p.id, tipo: p.tipo, nombre: p.nombre, mini: p.mini, creado: p.creado, actualizado: p.actualizado });
const mio = (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
  if (!p) fallo(res, 404, 'not_found', 'Este video ya no existe.');
  return p;
};
function estadoValido(e) { const s = JSON.stringify(e ?? {}); return s.length <= 400000 ? s : null; }
const miniValida = m => (typeof m === 'string' && /^data:image\/jpeg;base64,/.test(m) && m.length < 80000 ? m : '');

app.get('/api/projects', conSesion, (req, res) => {
  res.json({ proyectos: db.prepare('SELECT id, tipo, nombre, mini, creado, actualizado FROM projects WHERE user_id = ? ORDER BY actualizado DESC').all(req.user.id) });
});
app.post('/api/projects', conSesion, (req, res) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(req.user.id).n >= 300) return fallo(res, 400, 'too_many', 'Has llegado al máximo de videos guardados. Borra alguno para crear otro.');
  const estado = estadoValido(req.body?.estado);
  if (!estado) return fallo(res, 413, 'too_big', 'El proyecto es demasiado grande.');
  const id = crypto.randomBytes(8).toString('base64url'), t = now(), tipo = TIPOS.includes(req.body?.tipo) ? req.body.tipo : 'video';
  db.prepare('INSERT INTO projects (id, user_id, tipo, nombre, estado, mini, creado, actualizado) VALUES (?,?,?,?,?,?,?,?)').run(id, req.user.id, tipo, texto(req.body?.nombre, 120), estado, miniValida(req.body?.mini), t, t);
  res.json({ proyecto: { id, tipo, nombre: texto(req.body?.nombre, 120), estado: JSON.parse(estado), creado: t, actualizado: t } });
});
app.get('/api/projects/:id', conSesion, (req, res) => {
  const p = mio(req, res); if (!p) return;
  let estado = {}; try { estado = JSON.parse(p.estado); } catch {}
  res.json({ proyecto: { ...resumen(p), estado } });
});
app.put('/api/projects/:id', conSesion, (req, res) => {
  const p = mio(req, res); if (!p) return;
  const estado = req.body?.estado === undefined ? p.estado : estadoValido(req.body.estado);
  if (!estado) return fallo(res, 413, 'too_big', 'El proyecto es demasiado grande.');
  const nombre = req.body?.nombre === undefined ? p.nombre : texto(req.body.nombre, 120), mini = req.body?.mini === undefined ? p.mini : miniValida(req.body.mini);
  db.prepare('UPDATE projects SET nombre = ?, estado = ?, mini = ?, actualizado = ? WHERE id = ?').run(nombre, estado, mini, now(), p.id);
  res.json({ ok: true });
});
app.delete('/api/projects/:id', conSesion, (req, res) => {
  const p = mio(req, res); if (!p) return;
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

/* ---------- Claude ---------- */
// A Claude request can take a minute or more. The response starts at once and sends a space every
// few seconds so proxies with idle timeouts keep the connection open; the JSON arrives at the end.
function largo(res, trabajo) {
  res.status(200).set({ 'Content-Type': 'application/json; charset=utf-8', 'X-Accel-Buffering': 'no' });
  res.write(' ');
  const iv = setInterval(() => res.write(' '), 8000);
  trabajo().then(r => res.end(JSON.stringify({ ok: true, ...r })), e => {
    if (!(e instanceof ai.AIError)) console.error('[ai]', e);
    res.end(JSON.stringify({ ok: false, error: { code: e instanceof ai.AIError ? e.code : 'server', message: e instanceof ai.AIError ? e.message : 'Algo falló en el servidor. Vuelve a intentarlo.' } }));
  }).finally(() => clearInterval(iv));
}
const enCurso = new Map();
function rutaIA(accion, fn, activo = () => cfg.hasAI) {
  return (req, res) => {
    if (!activo()) return fallo(res, 503, 'ai_off', 'Claude no está configurado en este servidor.');
    const s = saldo(req.user), coste = COSTS[accion];
    if (s.quedan < coste) return fallo(res, 402, 'no_credits', 'Has usado todos tus créditos de Claude de este mes.');
    const n = enCurso.get(req.user.id) || 0;
    if (n >= 3) return fallo(res, 429, 'rate_limited', 'Claude ya está trabajando en otra petición tuya. Espera a que termine.');
    enCurso.set(req.user.id, n + 1);
    largo(res, async () => {
      try {
        const { data, usage } = await fn(req);
        registrarUso(req.user.id, accion, coste, usage);
        return { ...data, saldo: saldo(req.user) };
      } finally { const k = (enCurso.get(req.user.id) || 1) - 1; if (k > 0) enCurso.set(req.user.id, k); else enCurso.delete(req.user.id); }
    });
  };
}
const perfil = req => ({ ...publico(req.user).perfil, nombre: req.user.nombre });
app.post('/api/ai/guion', conSesion, rutaIA('guion', req => ai.guion({ perfil: perfil(req), ...req.body })));
app.post('/api/ai/montaje', conSesion, rutaIA('montaje', req => ai.montaje({ perfil: perfil(req), ...req.body })));
app.post('/api/ai/extractos', conSesion, rutaIA('extractos', req => ai.extractos({ perfil: perfil(req), ...req.body })));
app.post('/api/ai/afinar', conSesion, rutaIA('afinar', req => ai.afinar({ perfil: perfil(req), ...req.body })));
app.post('/api/ai/editar', conSesion, rutaIA('editar', req => ai.editar({ perfil: perfil(req), ...req.body })));
app.post('/api/ai/publicar', conSesion, rutaIA('publicar', req => ai.publicar({ perfil: perfil(req), ...req.body })));
app.post('/api/ai/transcribir', conSesion, audio, rutaIA('transcribir', req => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw new ai.AIError('no_audio', 'No llegó el audio.');
  return ai.transcribir(req.body, texto(req.query.idioma, 3));
}, () => cfg.hasSTT));

/* ---------- billing ---------- */
const origen = req => cfg.appUrl || `${req.protocol}://${req.get('host')}`;
app.post('/api/billing/checkout', conSesion, async (req, res) => {
  if (!cfg.hasBilling) return fallo(res, 404, 'no_billing', 'Los pagos no están activados.');
  try { res.json({ url: await billing.crearCheckout(req.user, origen(req)) }); } catch { fallo(res, 502, 'stripe', 'No se pudo abrir el pago. Vuelve a intentarlo.'); }
});
app.post('/api/billing/portal', conSesion, async (req, res) => {
  if (!cfg.hasBilling || !req.user.stripe_customer) return fallo(res, 404, 'no_billing', 'No hay una suscripción que gestionar.');
  try { res.json({ url: await billing.crearPortal(req.user, origen(req)) }); } catch { fallo(res, 502, 'stripe', 'No se pudo abrir la gestión del pago.'); }
});

/* ---------- admin ---------- */
app.get('/api/admin/users', conSesion, soloAdmin, (req, res) => {
  const filas = db.prepare(`SELECT u.id, u.email, u.nombre, u.rol, u.plan, u.creado,
      (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS videos,
      (SELECT COALESCE(SUM(creditos),0) FROM usage g WHERE g.user_id = u.id AND g.creado >= ?) AS creditos,
      (SELECT COALESCE(SUM(tokens_in),0) FROM usage g WHERE g.user_id = u.id AND g.creado >= ?) AS tokens_in,
      (SELECT COALESCE(SUM(tokens_out),0) FROM usage g WHERE g.user_id = u.id AND g.creado >= ?) AS tokens_out
    FROM users u ORDER BY u.creado`).all(inicioMes(), inicioMes(), inicioMes());
  res.json({ usuarios: filas, modelo: cfg.model });
});
app.put('/api/admin/users/:id', conSesion, soloAdmin, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(+req.params.id);
  if (!u) return fallo(res, 404, 'not_found', 'Esa cuenta no existe.');
  const plan = cfg.plans[req.body?.plan] ? req.body.plan : u.plan, rol = ['user', 'admin'].includes(req.body?.rol) && u.id !== req.user.id ? req.body.rol : u.rol;
  db.prepare('UPDATE users SET plan = ?, rol = ? WHERE id = ?').run(plan, rol, u.id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => fallo(res, 404, 'not_found', 'No existe.'));

/* ---------- front end ---------- */
// No build step and no hashed file names: every file revalidates, so a deploy is picked up at once.
app.use(express.static(publicDir, { setHeaders: (res, p) => res.set('Cache-Control', /\.woff2$/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache') }));
app.use((req, res) => (req.method === 'GET' ? res.sendFile(path.join(publicDir, 'index.html')) : res.status(404).end()));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return fallo(res, 413, 'too_big', 'El envío es demasiado grande.');
  if (err?.type === 'entity.parse.failed') return fallo(res, 400, 'bad_json', 'Petición no válida.');
  console.error(err);
  fallo(res, 500, 'server', 'Algo falló en el servidor. Vuelve a intentarlo.');
});
