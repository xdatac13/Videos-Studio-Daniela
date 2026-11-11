// End-to-end tests of the API in demo mode (no Claude key needed): node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-test-'));
Object.assign(process.env, { DATA_DIR: dir, AI_MOCK: '1', PLAN_FREE_CREDITS: '5', SIGNUP_MODE: 'open', INVITE_CODE: '', ADMIN_EMAIL: '' });
const { app } = await import('../server/app.js');
const { firmaValida } = await import('../server/billing.js');
const { db } = await import('../server/db.js');

let server, base;
before(async () => { server = app.listen(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function cliente() {
  let cookie = '';
  return async (ruta, { method = 'GET', body, raw, headers = {} } = {}) => {
    const r = await fetch(base + ruta, {
      method,
      headers: { 'x-requested-with': 'estudio', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}

test('signup, session, profile', async () => {
  const c = cliente();
  assert.equal((await c('/api/me')).json.user, null);
  assert.equal((await c('/api/auth/signup', { method: 'POST', body: { email: 'mala', pass: '12345678' } })).status, 400);
  assert.equal((await c('/api/auth/signup', { method: 'POST', body: { email: 'a@b.co', pass: 'corta' } })).status, 400);
  const r = await c('/api/auth/signup', { method: 'POST', body: { email: 'Dani@Ejemplo.com', pass: 'secreto-largo', nombre: 'Daniela' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, 'dani@ejemplo.com');
  assert.equal(r.json.user.rol, 'admin', 'the first account administers the studio');
  assert.equal(r.json.user.plan, 'pro');
  assert.equal((await c('/api/me')).json.user.nombre, 'Daniela');
  const p = await c('/api/me', { method: 'PUT', body: { nombre: 'Dani', perfil: { nicho: 'belleza' } } });
  assert.equal(p.json.user.perfil.nicho, 'belleza');
  assert.ok(p.json.user.perfil.tono, 'missing profile fields fall back to the defaults');
  assert.equal((await c('/api/auth/signup', { method: 'POST', body: { email: 'dani@ejemplo.com', pass: 'secreto-largo' } })).status, 409);
  await c('/api/auth/logout', { method: 'POST' });
  assert.equal((await c('/api/projects')).status, 401);
  assert.equal((await c('/api/auth/login', { method: 'POST', body: { email: 'dani@ejemplo.com', pass: 'otra-cosa' } })).status, 401);
  assert.equal((await c('/api/auth/login', { method: 'POST', body: { email: 'dani@ejemplo.com', pass: 'secreto-largo' } })).status, 200);
});

test('writes without the custom header are refused', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('projects belong to their owner', async () => {
  const a = cliente(), b = cliente();
  await a('/api/auth/signup', { method: 'POST', body: { email: 'a@ejemplo.com', pass: 'secreto-largo' } });
  await b('/api/auth/signup', { method: 'POST', body: { email: 'b@ejemplo.com', pass: 'secreto-largo' } });
  const { json } = await a('/api/projects', { method: 'POST', body: { nombre: 'Bolso', tipo: 'video', estado: { paso: 0 } } });
  const id = json.proyecto.id;
  assert.equal((await a(`/api/projects/${id}`)).json.proyecto.estado.paso, 0);
  assert.equal((await b(`/api/projects/${id}`)).status, 404);
  assert.equal((await b(`/api/projects/${id}`, { method: 'PUT', body: { nombre: 'robado' } })).status, 404);
  await a(`/api/projects/${id}`, { method: 'PUT', body: { estado: { paso: 3 }, nombre: 'Bolso Lisboa' } });
  const lista = (await a('/api/projects')).json.proyectos;
  assert.equal(lista.length, 1); assert.equal(lista[0].nombre, 'Bolso Lisboa');
  assert.equal((await b('/api/projects')).json.proyectos.length, 0);
  assert.equal((await a(`/api/projects/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await a(`/api/projects/${id}`)).status, 404);
});

test('Claude actions answer in demo mode and spend credits until the plan runs out', async () => {
  const c = cliente();
  const s = await c('/api/auth/signup', { method: 'POST', body: { email: 'c@ejemplo.com', pass: 'secreto-largo' } });
  assert.equal(s.json.saldo.total, 5);
  const g = await c('/api/ai/guion', { method: 'POST', body: { tipo: 'unboxing', brief: { nombre: 'Bolso' }, desc: 'rápido', dur: 30 } });
  assert.equal(g.json.ok, true); assert.ok(g.json.escenas.length >= 4); assert.equal(g.json.saldo.quedan, 4);
  const e = await c('/api/ai/editar', { method: 'POST', body: { proyecto: { escenas: [{ id: 'x1' }, { id: 'x2' }] }, mensaje: 'quita la escena 2' } });
  assert.deepEqual(e.json.ops.map(o => [o.op, o.id]), [['quitar', 'x2']]);
  const x = await c('/api/ai/extractos', { method: 'POST', body: { video: { dur: 480, nombre: 'v.mp4' }, cuantos: 6, min: 5, max: 10 } });
  assert.equal(x.status, 402, 'four credits needed, three left');
  const f = await c('/api/ai/afinar', { method: 'POST', body: { video: { dur: 480 }, clips: [{ id: 'c1', inicio: 10, fin: 18, desde: 6, hasta: 22 }] } });
  assert.equal(f.json.clips[0].id, 'c1'); assert.equal(f.json.saldo.quedan, 1);
  db.prepare("UPDATE users SET plan = 'pro' WHERE email = 'c@ejemplo.com'").run();
  const x2 = await c('/api/ai/extractos', { method: 'POST', body: { video: { dur: 480, nombre: 'v.mp4' }, cuantos: 6, min: 5, max: 10 } });
  assert.equal(x2.json.extractos.length, 6);
  for (const k of x2.json.extractos) assert.ok(k.fin - k.inicio >= 5 && k.fin - k.inicio <= 10 && k.fin <= 480);
  const wav = Buffer.alloc(44 + 32000 * 6);
  const t = await c('/api/ai/transcribir?idioma=es', { method: 'POST', raw: wav, headers: { 'content-type': 'audio/wav' } });
  assert.ok(t.json.palabras.length > 3);
});

test('only admins see the accounts', async () => {
  const admin = cliente(), otra = cliente();
  await admin('/api/auth/login', { method: 'POST', body: { email: 'dani@ejemplo.com', pass: 'secreto-largo' } });
  await otra('/api/auth/login', { method: 'POST', body: { email: 'b@ejemplo.com', pass: 'secreto-largo' } });
  assert.equal((await otra('/api/admin/users')).status, 403);
  const lista = (await admin('/api/admin/users')).json.usuarios;
  const b = lista.find(u => u.email === 'b@ejemplo.com');
  await admin(`/api/admin/users/${b.id}`, { method: 'PUT', body: { plan: 'pro' } });
  assert.equal((await otra('/api/me')).json.user.plan, 'pro');
});

test('Stripe webhook signatures', () => {
  const secreto = 'whsec_prueba', cuerpo = Buffer.from('{"type":"x"}'), t = Math.floor(Date.now() / 1000);
  const firma = crypto.createHmac('sha256', secreto).update(`${t}.${cuerpo}`).digest('hex');
  assert.equal(firmaValida(cuerpo, `t=${t},v1=${firma}`, secreto), true);
  assert.equal(firmaValida(Buffer.from('{"type":"y"}'), `t=${t},v1=${firma}`, secreto), false, 'tampered body');
  assert.equal(firmaValida(cuerpo, `t=${t - 4000},v1=${firma}`, secreto), false, 'stale timestamp');
  assert.equal(firmaValida(cuerpo, '', secreto), false);
});
