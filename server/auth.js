// Accounts and sessions: scrypt password hashes, random session tokens stored hashed, HttpOnly cookie.
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { cfg } from './config.js';

const DIAS = 30, COOKIE = 'sid';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export function hashPass(pass) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pass, salt, 64).toString('hex')}`;
}
export function checkPass(pass, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const atributos = () => `Path=/; HttpOnly; SameSite=Lax${cfg.production ? '; Secure' : ''}`;
export function abrirSesion(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expira) VALUES (?,?,?)').run(sha(token), userId, now() + DIAS * 864e5);
  res.append('Set-Cookie', `${COOKIE}=${token}; ${atributos()}; Max-Age=${DIAS * 86400}`);
}
export function cerrarSesion(req, res) {
  const t = leerCookie(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(t));
  res.append('Set-Cookie', `${COOKIE}=; ${atributos()}; Max-Age=0`);
}
function leerCookie(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

export function usuarioDe(req) {
  const t = leerCookie(req);
  if (!t) return null;
  const s = db.prepare('SELECT user_id, expira FROM sessions WHERE token = ?').get(sha(t));
  if (!s || s.expira < now()) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}
export function conSesion(req, res, next) {
  const u = usuarioDe(req);
  if (!u) return res.status(401).json({ error: { code: 'no_session', message: 'Inicia sesión para continuar.' } });
  req.user = u;
  next();
}
export function soloAdmin(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: { code: 'forbidden', message: 'Solo para administradoras.' } });
  next();
}

// Small in-memory limiter for the login and signup forms.
const intentos = new Map();
export function limitar(max, ventanaMs) {
  return (req, res, next) => {
    const k = req.ip + req.path, t = now(), lista = (intentos.get(k) || []).filter(x => t - x < ventanaMs);
    if (lista.length >= max) return res.status(429).json({ error: { code: 'rate_limited', message: 'Demasiados intentos. Espera unos minutos.' } });
    lista.push(t); intentos.set(k, lista);
    if (intentos.size > 5000) intentos.clear();
    next();
  };
}

// The creator's voice, used in every prompt. Each account can change it under "Mi cuenta".
export const PERFIL_BASE = {
  nicho: 'moda y viajes',
  tono: 'cómplice, cálido y chic; tutea, frases cortas y concretas, un matiz sincero en el veredicto',
  idioma: 'español',
};
export function perfilDe(u) {
  let p = {};
  try { p = JSON.parse(u.perfil || '{}') || {}; } catch {}
  return { ...PERFIL_BASE, ...p };
}
export const publico = u => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, plan: u.plan, perfil: perfilDe(u) });
