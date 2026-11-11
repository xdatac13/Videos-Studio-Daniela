// Checks the requests the studio sends to Claude, against a local stand-in for the API.
// It verifies the shape of each request and how replies are read; it does not call Anthropic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-ai-'));
const pedidos = [];
let responder = () => ({ status: 200, texto: '{}' });
const falso = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', d => (cuerpo += d));
  req.on('end', () => {
    const p = { url: req.url, beta: req.headers['anthropic-beta'] || '', body: JSON.parse(cuerpo) };
    pedidos.push(p);
    const r = responder(p);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.status === 200
      ? { id: 'msg_1', type: 'message', role: 'assistant', model: p.body.model, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: r.texto }], stop_reason: r.stop || 'end_turn', stop_sequence: null, usage: { input_tokens: 11, output_tokens: 22 } }
      : { type: 'error', error: { type: 'invalid_request_error', message: 'no' } }));
  });
});
await new Promise(r => falso.listen(0, r));
Object.assign(process.env, { DATA_DIR: dir, AI_MOCK: '', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${falso.address().port}`, CLAUDE_MODEL: '', CLAUDE_EFFORT: '', CLAUDE_FALLBACKS: '' });
const ai = await import('../server/ai.js');
const perfil = { nombre: 'Daniela', nicho: 'moda y viajes', tono: 'cálido', idioma: 'español' };
const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

before(() => { pedidos.length = 0; });
after(() => { falso.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('script request: model, effort, schema and refusal fallback', async () => {
  responder = () => ({ status: 200, texto: JSON.stringify({ escenas: [{ nombre: 'Gancho', toma: 'El bolso', frase: 'Mira esto.', rotulo_tipo: 'titulo', rotulo_texto: 'Bolso' }, { nombre: 'Cierre', toma: 'A cámara', frase: 'Enlace en bio.', rotulo_tipo: 'raro', rotulo_texto: '' }] }) });
  const { data, usage } = await ai.guion({ perfil, tipo: 'unboxing', brief: { nombre: 'Bolso' }, desc: 'rápido', dur: 30 });
  const p = pedidos.at(-1);
  assert.equal(p.body.model, 'claude-opus-5-5');
  assert.equal(p.body.output_config.effort, 'medium');
  assert.equal(p.body.output_config.format.type, 'json_schema');
  assert.equal(p.body.output_config.format.schema.additionalProperties, false);
  assert.equal(p.body.fallbacks, 'default');
  assert.match(p.beta, /server-side-fallback-2026-07-01/);
  assert.equal(p.body.thinking, undefined, 'thinking is left to the model default');
  assert.equal(p.body.temperature, undefined);
  assert.match(p.body.system, /Daniela/);
  assert.equal(data.escenas.length, 2);
  assert.equal(data.escenas[1].rotulo_tipo, 'none', 'unknown caption kinds are normalised');
  assert.deepEqual(usage, { input_tokens: 11, output_tokens: 22 });
});

test('highlights: contact sheets go as images, transcript and loudness as text, cuts are clamped', async () => {
  responder = () => ({ status: 200, texto: JSON.stringify({ resumen: 'Visita', extractos: [{ inicio: 10, fin: 40, titulo: 'Vistas', gancho: 'Mira', motivo: 'm', puntuacion: 130, descripcion: 'd' }, { inicio: 470, fin: 520, titulo: 'Final', gancho: 'g', motivo: 'm', puntuacion: 60, descripcion: 'd' }] }) });
  const { data } = await ai.extractos({ perfil, video: { dur: 480, nombre: 'v.mp4' }, contexto: 'castillo', cuantos: 2, min: 5, max: 10, hojas: [PIXEL, PIXEL], palabras: [{ t: 'hola', a: 1, b: 1.4 }, { t: 'mundo', a: 1.5, b: 2 }, { t: 'después', a: 4, b: 4.6 }], energia: '0123', paso: 4 });
  const c = pedidos.at(-1).body.messages[0].content;
  assert.deepEqual(c.map(x => x.type), ['image', 'image', 'text']);
  assert.equal(c[0].source.media_type, 'image/jpeg');
  assert.match(c[2].text, /\[1\.0-2\.0\] hola mundo/);
  assert.match(c[2].text, /\[4\.0-4\.6\] después/);
  assert.match(c[2].text, /0123/);
  assert.deepEqual(data.extractos.map(x => [x.inicio, x.fin]), [[10, 20], [470, 480]], 'too long is cut to the maximum; the end stays inside the video');
  assert.equal(data.extractos[0].puntuacion, 100);
});

test('a rejected structured request is retried in plain mode and the JSON is read from the text', async () => {
  let n = 0;
  responder = () => (++n === 1 ? { status: 400 } : { status: 200, texto: 'Aquí tienes:\n{"mensaje":"Hecho.","ops":[{"op":"quitar","id":"e2","campo":"","valor":"","pos":0}]}' });
  const antes = pedidos.length;
  const { data } = await ai.editar({ perfil, proyecto: { escenas: [{ id: 'e1' }, { id: 'e2' }] }, mensaje: 'quita la 2', historial: [{ de: 'yo', texto: 'hola' }, { de: 'claude', texto: 'dime' }], hoja: PIXEL });
  assert.equal(pedidos.length - antes, 2);
  assert.equal(pedidos.at(-1).body.output_config, undefined);
  assert.equal(pedidos.at(-1).body.fallbacks, undefined);
  assert.deepEqual(data.ops, [{ op: 'quitar', id: 'e2', campo: '', valor: '', pos: 0 }]);
  assert.match(pedidos.at(-1).body.messages[0].content.at(-1).text, /Creadora: hola\nTú: dime/);
});

test('refusals and truncated answers become clear errors', async () => {
  responder = () => ({ status: 200, texto: '', stop: 'refusal' });
  await assert.rejects(ai.publicar({ perfil, tipo: 'unboxing', brief: {}, guion: ['a'] }), e => e.code === 'refusal');
  responder = () => ({ status: 200, texto: '{"instagram":"a', stop: 'max_tokens' });
  await assert.rejects(ai.publicar({ perfil, tipo: 'unboxing', brief: {}, guion: ['a'] }), e => e.code === 'too_long');
  responder = () => ({ status: 200, texto: 'no es json' });
  await assert.rejects(ai.publicar({ perfil, tipo: 'unboxing', brief: {}, guion: ['a'] }), e => e.code === 'invalid_json');
});

test('refine pass keeps each cut inside the window it was shown', async () => {
  responder = () => ({ status: 200, texto: JSON.stringify({ clips: [{ id: 'c1', inicio: 2, fin: 30 }, { id: 'c2', inicio: 101.3, fin: 108.9 }, { id: 'zz', inicio: 1, fin: 9 }] }) });
  const { data } = await ai.afinar({ perfil, video: { dur: 480 }, min: 5, max: 10, hojas: [PIXEL, PIXEL], clips: [{ id: 'c1', titulo: 'a', inicio: 10, fin: 18, desde: 7, hasta: 21 }, { id: 'c2', titulo: 'b', inicio: 100, fin: 109, desde: 97, hasta: 112 }] });
  assert.deepEqual(data.clips, [{ id: 'c1', inicio: 10, fin: 18 }, { id: 'c2', inicio: 101.3, fin: 108.9 }], 'an out-of-range answer falls back to the first cut; unknown ids are dropped');
});
