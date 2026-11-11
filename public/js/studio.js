// The guided studio: Idea → Guion → Voz → Tomas → Montaje. One task per screen.
// The voice-over leads: it sets each scene's length, and the pictures are laid on top of it.
import { $, $$, esc, fmt, seg, uid, clamp, palabras, slug, guardarArchivo, copiar, descargar, avisar } from './util.js';
import { api, ia, mensajeDe } from './api.js';
import { idb, pedirPersistencia } from './idb.js';
import { decodificar, analizar, construir, oir, pararOir } from './audio.js';
import { cargarMedia, hojasTomas, hojaMiniaturas } from './media.js';
import { motor, TAMANOS, puedeExportar, AVISO_FORMATO } from './render.js';
import * as chat from './chat.js';

const PASOS = ['Idea', 'Guion', 'Voz', 'Tomas', 'Montaje'];
const FORMATOS = [['9x16', '9:16 Reels'], ['4x5', '4:5 Feed'], ['1x1', '1:1'], ['16x9', '16:9 YouTube']];
const ROT = [['none', 'Sin rótulo'], ['titulo', 'Título'], ['ficha', 'Ficha de punto fuerte'], ['cta', 'Llamada a la acción']];
const EJ = {
  unboxing: { nombre: 'Bolso de viaje Lisboa', marca: 'Casa Alba', p1: 'Piel suave y ligera', p2: 'Bolsillo interior para el pasaporte', p3: 'Cabe en la maleta de cabina', veredicto: 'Bonito, práctico y se nota la calidad.', dato: '', cta: 'Te dejo el enlace en mi bio.' },
  lugar: { nombre: 'Castillo de San Felipe', marca: 'Cartagena, Colombia', p1: 'Las vistas desde lo alto', p2: 'Los túneles de piedra', p3: 'El atardecer sobre la ciudad', veredicto: 'Si te gusta la historia, es una parada obligatoria.', dato: 'Ve temprano: menos calor y menos gente.', cta: 'Guarda este video para tu viaje.' },
};
const ETQ = {
  unboxing: { nombre: '¿Qué producto es?', marca: 'Marca', p: 'Tus 3 puntos fuertes', veredicto: 'Tu veredicto sincero, en una frase', dato: 'Precio (opcional)', cta: '¿Qué quieres que haga quien lo ve?' },
  lugar: { nombre: '¿Qué lugar visitas?', marca: 'Ciudad o país', p: '3 cosas que no hay que perderse', veredicto: '¿Vale la pena? En una frase', dato: 'Consejo práctico (precio, horario, mejor hora)', cta: '¿Qué quieres que haga quien lo ve?' },
};

export const estadoNuevo = (tipo = 'unboxing') => ({ v: 2, paso: 0, tipo, ejemplo: true, brief: { ...EJ[tipo] }, dur: 45, formato: '9x16', encuadre: 'llenar', escenas: [], ritmo: 1, cortes: [], vozIds: [], subt: true, musVol: 0.5, modo: 'base', desc: '', descV: '', guardadas: { base: null, claude: null, video: null }, chat: [], kit: null });
const vozVacia = () => ({ buf: null, limpio: null, keeps: [], pausas: [], picos: null, nombre: '', n: 0 });

let S = null, R = null, PID = '', V = null, ac = null, tSave = 0, sucio = false;

/* ---------- saving: structure to the server, media to this device ---------- */
const nombreProyecto = () => (S.ejemplo ? '' : S.brief.nombre.trim()) || (S.tipo === 'unboxing' ? 'Unboxing sin título' : 'Visita sin título');
function miniProyecto() { for (const e of S.escenas) { const m = R.media.get(e.mediaId); if (m && m.thumb) return m.thumb; } const m = [...R.media.values()].find(x => x.thumb); return m ? m.thumb : ''; }
function guardarYa(keepalive) {
  clearTimeout(tSave); if (!sucio || !S) return; sucio = false;
  api('/projects/' + PID, { method: 'PUT', keepalive, body: { nombre: nombreProyecto(), estado: S, ...(keepalive ? {} : { mini: miniProyecto() }) } }).catch(() => { sucio = true; });
}
function guardar() { sucio = true; clearTimeout(tSave); tSave = setTimeout(() => guardarYa(), 800); }
const clave = k => PID + '/' + k;

/* ---------- script templates (the playbook's proven structures) ---------- */
function nuevaEsc(o) { return Object.assign({ id: uid(), nombre: 'Escena', toma: '', frase: '', rot: 'none', rotTxt: '', extra: 0, fija: 0, mediaId: '', inicio: 0, sonido: 0.2 }, o); }
function plantilla() {
  const b = S.brief, n = b.nombre || '', ps = [b.p1, b.p2, b.p3].filter(x => x && x.trim());
  const ord = ['Lo primero', 'Además', 'Y mi detalle favorito'], min = p => p.charAt(0).toLowerCase() + p.slice(1);
  if (S.tipo === 'unboxing') return [
    nuevaEsc({ nombre: 'Gancho', toma: 'Primer plano del producto o de la caja cerrada', frase: `¡Por fin llegó! ${n}${b.marca ? ' de ' + b.marca : ''}.`, rot: 'titulo', rotTxt: n }),
    nuevaEsc({ nombre: 'Apertura', toma: 'Tus manos abriendo la caja, de cerca', frase: 'Mira cómo viene: cada detalle está cuidado.', extra: 1.5, sonido: 0.8 }),
    nuevaEsc({ nombre: 'Descubrimiento', toma: 'El producto saliendo de la caja', frase: 'Y aquí está. Mi primera impresión: me encanta.' }),
    ...ps.map((p, i) => nuevaEsc({ nombre: 'Punto fuerte ' + (i + 1), toma: 'Primer plano de ese detalle', frase: `${ord[i]}: ${min(p)}.`, rot: 'ficha', rotTxt: p })),
    nuevaEsc({ nombre: 'En uso', toma: 'Tú usando o llevando el producto', frase: 'Así queda en el día a día.' }),
    nuevaEsc({ nombre: 'Veredicto', toma: 'El producto bonito, o tú mirando a cámara', frase: `${b.veredicto || ''} ${b.dato ? 'Cuesta ' + b.dato + '. ' : ''}${b.cta || ''}`.trim(), rot: 'cta', rotTxt: b.cta || '' })];
  return [
    nuevaEsc({ nombre: 'Gancho', toma: 'El plano más espectacular del lugar', frase: `Si vienes a ${b.marca || 'esta ciudad'}, no te pierdas ${n}.`, rot: 'titulo', rotTxt: n }),
    nuevaEsc({ nombre: 'Llegada', toma: 'Tú llegando: la entrada, la calle, la fachada', frase: 'Así se llega, y esto es lo primero que ves.', sonido: 0.5 }),
    ...ps.map((p, i) => nuevaEsc({ nombre: 'Imprescindible ' + (i + 1), toma: 'Plano amplio y un detalle de cerca', frase: `${ord[i]}: ${min(p)}.`, rot: 'ficha', rotTxt: p })),
    ...(b.dato ? [nuevaEsc({ nombre: 'Consejo práctico', toma: 'El cartel de precios, la cola o el mapa', frase: `Mi consejo: ${b.dato}` })] : []),
    nuevaEsc({ nombre: 'Veredicto', toma: 'Tú mirando a cámara, o un último plano bonito', frase: `${b.veredicto || ''} ${b.cta || ''}`.trim(), rot: 'cta', rotTxt: b.cta || '' })];
}
const planDe = e => Math.max(2.5, palabras(e.frase) / 2.5 + 0.4);
const vozEsc = () => S.escenas.filter(e => e.frase.trim());

/* ---------- the voice: cleaned recording, then shared out between the scenes ---------- */
// S.vozIds lists the scenes in the order they were read; S.cortes are the cut points between them.
// Keeping the ids means a scene keeps its own stretch of voice when scenes are moved or removed.
function procesarVoz(conservar) {
  const b = R.voz.buf; if (!b) return; const an = analizar(b, S.ritmo);
  Object.assign(R.voz, { keeps: an.keeps, pausas: an.pausas, n: an.n, limpio: construir(b, an.keeps) });
  if (!(conservar && S.vozIds.length && S.cortes.length === S.vozIds.length - 1)) repartir();
}
function repartir() {
  const v = R.voz.limpio; if (!v) { S.cortes = []; S.vozIds = []; return; }
  const previas = S.vozIds.map(id => S.escenas.find(e => e.id === id)), es = previas.length && previas.every(Boolean) ? previas : vozEsc();
  const tot = v.duration, w = es.map(e => palabras(e.frase) || 1), sum = w.reduce((a, b) => a + b, 0) || 1; let acc = 0, prev = 0; const out = [];
  for (let i = 0; i < es.length - 1; i++) {
    acc += w[i]; const t = tot * acc / sum; let best = null;
    for (const p of R.voz.pausas) if (p.t > prev + 0.4 && p.t < tot - 0.3 && Math.abs(p.t - t) <= 1.5 && (best === null || Math.abs(p.t - t) < Math.abs(best - t))) best = p.t;
    const x = clamp(best ?? t, prev + 0.3, tot - 0.2 * (es.length - 1 - i)); out.push(x); prev = x;
  }
  S.vozIds = es.map(e => e.id); S.cortes = out; guardar();
}
function asegurarCortes() { if (R.voz.limpio && !(S.vozIds.length && S.cortes.length === S.vozIds.length - 1)) repartir(); }
function tramos() { const v = R.voz.limpio; if (!v) return []; const n = S.vozIds.length; return S.vozIds.map((id, k) => ({ id, k, e: S.escenas.find(x => x.id === id), a: k === 0 ? 0 : S.cortes[k - 1], b: k === n - 1 ? v.duration : S.cortes[k] })); }
async function ponerVoz(blob, nombre) {
  R.err = ''; R.ocupado = 'Escuchando tu audio…'; pintarVista();
  try { R.voz.buf = await decodificar(blob); R.voz.nombre = nombre; R.voz.picos = null; idb.put(clave('voz'), { blob, name: nombre }); S.vozIds = []; S.cortes = []; procesarVoz(); }
  catch { R.err = 'No pude leer este audio. Prueba con un archivo .m4a, .mp3 o .wav.'; }
  R.ocupado = ''; pintarVista();
}
function quitarVoz() { pararOir(); R.voz = vozVacia(); S.cortes = []; S.vozIds = []; idb.del(clave('voz')); guardar(); pintarVista(); }
async function grabar() {
  if (R.grab) { R.grab.rec.stop(); return; }
  let st; try { st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { R.micNo = true; pintarVista(); return; }
  const rec = new MediaRecorder(st), ch = []; rec.ondataavailable = e => e.data.size && ch.push(e.data);
  rec.onstop = () => { st.getTracks().forEach(t => t.stop()); clearInterval(R.grab.iv); R.grab = null; ponerVoz(new Blob(ch, { type: rec.mimeType }), 'Grabación'); };
  R.grab = { rec, t0: Date.now(), iv: setInterval(() => { const el = $('#crono'); if (el) el.textContent = fmt((Date.now() - R.grab.t0) / 1000); }, 500) }; rec.start(); pintarVista();
}

/* ---------- takes ---------- */
async function subirTomas(files) {
  const fs = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); if (!fs.length) return;
  R.ocupado = `Preparando ${fs.length} toma${fs.length > 1 ? 's' : ''}…`; pintarVista(); pedirPersistencia();
  const nuevos = []; for (const f of fs) { const m = await cargarMedia(f); R.media.set(m.id, m); idb.put(clave('m/' + m.id), { blob: f, name: m.name }); nuevos.push(m); }
  const ok = nuevos.filter(m => !m.err); for (const e of S.escenas) { if (!ok.length) break; if (!R.media.has(e.mediaId)) { e.mediaId = ok.shift().id; e.inicio = 0; } }
  R.ocupado = ''; guardar(); pintarVista();
}
function quitarMedia(id) { const m = R.media.get(id); if (m) { URL.revokeObjectURL(m.url); R.media.delete(id); idb.del(clave('m/' + id)); S.escenas.forEach(e => { if (e.mediaId === id) { e.mediaId = ''; motor.olvidar(e.id); } }); guardar(); pintarVista(); } }

/* ---------- timeline and composition ---------- */
function linea() {
  const v = R.voz.limpio, tot = v ? v.duration : 0, n = S.vozIds.length; let t = 0; const items = [];
  for (const e of S.escenas) {
    let a = 0, b = 0; const k = v ? S.vozIds.indexOf(e.id) : -1;
    if (k >= 0) { a = k === 0 ? 0 : (S.cortes[k - 1] ?? tot); b = k === n - 1 ? tot : (S.cortes[k] ?? tot); }
    const vd = Math.max(0, b - a), dur = (vd > 0 ? vd : (+e.fija > 0 ? +e.fija : planDe(e))) + (+e.extra || 0); items.push({ e, ini: t, dur, a, b, vd }); t += dur;
  }
  return { items, total: t };
}
function trozos(fr) { const ws = fr.trim().split(/\s+/), out = []; let l = ''; for (const w of ws) { const p = l ? l + ' ' + w : w; if (l && (p.length > 24 || l.split(' ').length >= 4)) { out.push(l); l = w; } else l = p; } if (l) out.push(l); return out; }
function subsDe(it) { if (it.vd <= 0 || !it.e.frase.trim()) return []; const ch = trozos(it.e.frase), tot = ch.reduce((a, c) => a + c.length + 2, 0); let acc = 0; return ch.map(c => { const a = acc; acc += (c.length + 2) / tot * it.vd; return { a, b: acc, tx: c }; }); }
function composicion() {
  const L = linea(), [W, H] = TAMANOS[S.formato] || TAMANOS['9x16'], limpio = R.limpio;
  return {
    W, H, total: L.total, encuadre: S.encuadre, subt: S.subt && !limpio, voz: R.voz.limpio, musica: R.musica.buf, musVol: S.musVol,
    items: L.items.map((it, i) => { const e = it.e; return { key: e.id, nombre: e.nombre, ini: it.ini, dur: it.dur, m: R.media.get(e.mediaId) || null, inicio: +e.inicio || 0, sonido: e.sonido, rot: limpio ? 'none' : e.rot, rotTxt: e.rotTxt, ojo: S.brief.marca, alt: i % 2, subs: subsDe(it), vozA: it.a, vozDur: it.vd, falta: 'Falta la toma: ' + (e.toma || 'elige un video en el paso Tomas') }; }),
  };
}
function uiTiempo(t, total) { const s = $('#barra'), l = $('#reloj'); if (s) { s.max = total.toFixed(2); s.value = t; } if (l) l.textContent = fmt(t) + ' / ' + fmt(total); }
const detener = () => motor.detener();

/* ---------- export ---------- */
async function exportar() {
  if (motor.exportando) return; R.err = ''; if (R.res) { URL.revokeObjectURL(R.res.url); R.res = null; }
  R.exp = { total: linea().total }; pintarVista();
  try {
    const r = await motor.exportar((t, tot) => { const p = $('#prog'), l = $('#progTxt'); if (p) p.value = t / tot; if (l) l.textContent = `${fmt(t)} de ${fmt(tot)}`; });
    if (r) R.res = { ...r, url: URL.createObjectURL(r.blob), nombre: `${S.tipo === 'unboxing' ? 'unboxing-' : 'visita-'}${slug(S.brief.nombre)}-${S.formato}.${r.ext}`, mb: r.blob.size / 1048576, msg: '' };
  } catch (e) { R.err = mensajeDe(e); }
  R.exp = null; motor.mostrar(0); pintarVista();
}
async function guardarVideo() {
  const r = R.res; if (!r) return; const que = await guardarArchivo(r.blob, r.nombre);
  r.msg = que === 'compartido' ? 'Listo. Elige «Guardar video» para tenerlo en tu galería.' : que === 'descargado' ? 'Video descargado. Búscalo en tu carpeta de descargas.' : ''; pintarVista();
}
// Cover: the frame under the playhead, clean, with the cover text in the brand's title card.
async function portada() {
  const txt = (S.kit && S.kit.portada) || S.brief.nombre; R.limpio = true; let cv; try { cv = await motor.foto(motor.t); } finally { R.limpio = false; }
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const x = c.getContext('2d'); x.drawImage(cv, 0, 0);
  const W = c.width, H = c.height, U = Math.min(W, H), fs = Math.round(U * 0.105); x.font = `600 ${fs}px "Cormorant Garamond", Georgia, serif`;
  const ws = String(txt).trim().split(/\s+/), ls = []; let l = ''; for (const w of ws) { const p = l ? l + ' ' + w : w; if (l && x.measureText(p).width > U * 0.7) { ls.push(l); l = w; } else l = p; } if (l) ls.push(l);
  const tw = Math.max(...ls.map(q => x.measureText(q).width)), w = Math.max(tw, U * 0.4) + U * 0.14, h = U * 0.1 + ls.length * fs * 1.06 + U * 0.07, bx = (W - w) / 2, by = H * 0.58;
  x.fillStyle = '#fbf6f4'; x.beginPath(); const rt = Math.min(w / 2, U * 0.14), rb = U * 0.03; x.moveTo(bx + rt, by); x.lineTo(bx + w - rt, by); x.arcTo(bx + w, by, bx + w, by + rt, rt); x.lineTo(bx + w, by + h - rb); x.arcTo(bx + w, by + h, bx + w - rb, by + h, rb); x.lineTo(bx + rb, by + h); x.arcTo(bx, by + h, bx, by + h - rb, rb); x.lineTo(bx, by + rt); x.arcTo(bx, by, bx + rt, by, rt); x.closePath(); x.fill();
  x.fillStyle = '#7a2440'; x.textAlign = 'center'; x.textBaseline = 'top'; ls.forEach((q, k) => x.fillText(q, W / 2, by + U * 0.1 + k * fs * 1.06));
  c.toBlob(b => { if (b) descargar(b, `portada-${slug(S.brief.nombre)}.jpg`); motor.mostrar(motor.t); }, 'image/jpeg', 0.92);
}

/* ---------- Claude: script, video-first montage, publishing kit ---------- */
function ponerEscenas(es) { S.escenas = es; S.cortes = []; S.vozIds = []; S.ejemplo = false; S.guionEditado = true; guardar(); }
async function conClaude() {
  const desc = String(S.desc || '').trim();
  if (!desc) { R.err = 'Escribe primero, en una o dos frases, cómo imaginas tu video.'; return pintarVista(); }
  R.ocupado = 'Claude está creando tu estructura…'; R.err = ''; pintarVista();
  try {
    const d = await ia.pedir('guion', { tipo: S.tipo, brief: S.brief, desc, dur: S.dur });
    ponerEscenas(d.escenas.slice(0, 10).map((x, i) => nuevaEsc({ nombre: x.nombre, toma: x.toma, frase: x.frase, rot: x.rotulo_tipo, rotTxt: x.rotulo_texto, sonido: i === 1 ? 0.8 : 0.2, extra: i === 1 && S.tipo === 'unboxing' ? 1.5 : 0 })));
  } catch (e) { R.err = mensajeDe(e); }
  R.ocupado = ''; pintarVista();
}
const tomasOk = () => [...R.media.values()].filter(m => !m.err && (m.kind === 'image' || m.dur > 0));
async function montajeClaude() {
  const lista = tomasOk().map((m, i) => ({ m, id: 'T' + (i + 1) }));
  if (!lista.length) { R.err = 'Sube primero tus tomas en bruto.'; return pintarVista(); }
  R.ocupado = 'Claude está mirando tus tomas…'; R.err = ''; pintarVista();
  try {
    const hojas = await hojasTomas(lista, 20);
    R.ocupado = 'Claude está montando tu video…'; pintarVista();
    const d = await ia.pedir('montaje', { tipo: S.tipo, brief: S.brief, desc: S.descV, dur: S.dur, tomas: lista.map(({ m, id }) => ({ id, tipo: m.kind === 'video' ? 'video' : 'foto', dur: m.dur })), hojas });
    const porId = new Map(lista.map(x => [x.id, x.m]));
    const nuevas = d.planos.slice(0, 30).map(p => {
      const m = porId.get(p.toma); if (!m) return null; let a = p.inicio, f = p.fin;
      if (m.kind === 'video') { a = clamp(a, 0, Math.max(0, m.dur - 0.5)); f = clamp(f, a + 0.5, m.dur); } else { a = 0; if (!(f > 0)) f = 2.5; }
      return nuevaEsc({ nombre: p.nombre, mediaId: m.id, inicio: +a.toFixed(2), fija: +clamp(f - a, 0.8, 8).toFixed(2), sonido: p.sonido === 'original' ? 1 : 0.15, rot: p.rotulo_tipo, rotTxt: p.rotulo_texto });
    }).filter(Boolean);
    if (!nuevas.length) throw { message: 'Claude no pudo hacer el montaje esta vez. Vuelve a intentarlo.' };
    ponerEscenas(nuevas);
  } catch (e) { R.err = e && e.code === 'muchas' ? `Demasiadas tomas para una sola vez: deja como máximo ${e.max}.` : mensajeDe(e); }
  R.ocupado = ''; pintarVista();
}
async function kitPublicacion() {
  R.kitOcupado = true; R.err = ''; pintarVista();
  try { const d = await ia.pedir('publicar', { tipo: S.tipo, brief: S.brief, guion: vozEsc().map(e => e.frase) }); S.kit = { instagram: d.instagram, tiktok: d.tiktok, titulo_corto: d.titulo_corto, hashtags: d.hashtags, portada: d.portada, ganchos: d.ganchos }; guardar(); }
  catch (e) { R.err = mensajeDe(e); }
  R.kitOcupado = false; pintarVista();
}

/* ---------- editing by chat: what Claude sees, and how its changes are applied ---------- */
const AJ = () => ({ escenas: S.escenas, formato: S.formato, subt: S.subt, musVol: S.musVol, ritmo: S.ritmo, encuadre: S.encuadre, cortes: S.cortes, vozIds: S.vozIds });
function contextoChat() {
  const L = linea(), ms = tomasOk(), tid = new Map(ms.map((m, i) => [m.id, 'T' + (i + 1)]));
  return {
    porT: new Map(ms.map((m, i) => ['T' + (i + 1), m])),
    hoja: hojaMiniaturas(ms.map(m => ({ m, id: tid.get(m.id) }))),
    proyecto: {
      tipo: S.tipo === 'unboxing' ? 'unboxing' : 'lugar turístico', formato: S.formato, encuadre: S.encuadre, subtitulos: S.subt ? 'si' : 'no', voz_grabada: !!R.voz.limpio, musica: R.musica.buf ? { volumen: S.musVol } : null, ritmo: S.ritmo, duracion_total_s: +L.total.toFixed(1), duracion_objetivo_s: S.dur, datos: S.brief,
      escenas: L.items.map((it, i) => ({ id: it.e.id, n: i + 1, nombre: it.e.nombre, toma: it.e.toma, frase: it.e.frase, rotulo_tipo: it.e.rot, rotulo_texto: it.e.rotTxt, media: tid.get(it.e.mediaId) || '', inicio: +it.e.inicio || 0, duracion: +it.dur.toFixed(1), respiro: +it.e.extra || 0, sonido: it.e.sonido, con_voz: it.vd > 0 })),
      tomas: ms.map(m => ({ id: tid.get(m.id), nombre: m.name, tipo: m.kind === 'video' ? 'video' : 'foto', duracion_s: +m.dur.toFixed(1) })),
    },
  };
}
function aplicarOps(ops, porT) {
  const antes = JSON.stringify(AJ()), alias = new Map(), num = v => parseFloat(String(v).replace(',', '.')); let n = 0, ritmo = false;
  const esc_ = id => S.escenas.find(e => e.id === (alias.get(id) || id));
  for (const o of ops) {
    const v = String(o.valor ?? '').trim();
    if (o.op === 'cambiar') {
      const e = esc_(o.id); if (!e) continue; const k = o.campo; let ok = true;
      if (k === 'nombre') e.nombre = v.slice(0, 40); else if (k === 'toma') e.toma = v.slice(0, 200); else if (k === 'frase') e.frase = v.slice(0, 500);
      else if (k === 'rotulo_tipo') { if (ROT.some(r => r[0] === v)) e.rot = v; else ok = false; } else if (k === 'rotulo_texto') e.rotTxt = v.slice(0, 60);
      else if (k === 'media') { const m = porT.get(v.toUpperCase()); if (m) { e.mediaId = m.id; e.inicio = 0; } else if (!v) e.mediaId = ''; else ok = false; }
      else if (k === 'inicio' && isFinite(num(v))) { const m = R.media.get(e.mediaId); e.inicio = +clamp(num(v), 0, m && m.dur ? Math.max(0, m.dur - 0.3) : 600).toFixed(2); }
      else if (k === 'duracion' && isFinite(num(v))) e.fija = +clamp(num(v), 0.5, 30).toFixed(2);
      else if (k === 'respiro' && isFinite(num(v))) e.extra = clamp(Math.round(num(v) * 2) / 2, 0, 4);
      else if (k === 'sonido' && isFinite(num(v))) e.sonido = clamp(num(v), 0, 1); else ok = false;
      if (ok) n++;
    } else if (o.op === 'anadir') { const e = nuevaEsc({ nombre: 'Nueva escena' }); alias.set(o.id, e.id); S.escenas.splice(clamp((o.pos || S.escenas.length + 1) - 1, 0, S.escenas.length), 0, e); n++; }
    else if (o.op === 'quitar') { const e = esc_(o.id); if (e && S.escenas.length > 1) { S.escenas.splice(S.escenas.indexOf(e), 1); motor.olvidar(e.id); n++; } }
    else if (o.op === 'mover') { const e = esc_(o.id); if (e) { S.escenas.splice(S.escenas.indexOf(e), 1); S.escenas.splice(clamp((o.pos || 1) - 1, 0, S.escenas.length), 0, e); n++; } }
    else if (o.op === 'ajuste') {
      const k = o.campo; let ok = true;
      if (k === 'formato' && TAMANOS[v]) S.formato = v; else if (k === 'subtitulos') S.subt = /^s[ií]/i.test(v);
      else if (k === 'musica_volumen' && isFinite(num(v))) S.musVol = clamp(num(v), 0, 1); else if (k === 'encuadre' && ['llenar', 'ajustar'].includes(v)) S.encuadre = v;
      else if (k === 'ritmo' && [0, 1, 2].includes(num(v))) { S.ritmo = num(v); ritmo = true; } else ok = false;
      if (ok) n++;
    }
  }
  if (!n) return 0;
  R.deshacer.push(antes); if (R.deshacer.length > 20) R.deshacer.shift();
  detener(); if (ritmo) procesarVoz(); S.guionEditado = true; S.ejemplo = false; guardar(); pintarVista();
  return n;
}
function deshacer() {
  const s = R.deshacer.pop(); if (!s) return false; const a = JSON.parse(s), ritmo = a.ritmo !== S.ritmo;
  Object.assign(S, a); detener(); if (ritmo) procesarVoz(true); guardar(); pintarVista(); return true;
}

/* ---------- views ---------- */
function cambiarModo(m) { if (m === S.modo || R.ocupado) return; detener(); pararOir(); S.guardadas[S.modo] = S.escenas; S.escenas = S.guardadas[m] || (m === 'base' ? plantilla() : []); S.guardadas[m] = null; S.modo = m; S.cortes = []; S.vozIds = []; R.err = ''; guardar(); pintarVista(); }
function irA(p) {
  detener(); pararOir();
  if (p >= 1 && S.paso === 0 && S.briefCambiado && S.modo === 'claude') S.guardadas.base = null;
  if (p >= 1 && S.modo === 'base' && (!S.escenas.length || (S.paso === 0 && S.briefCambiado && !S.guionEditado))) { S.escenas = plantilla(); S.cortes = []; S.vozIds = []; S.briefCambiado = false; }
  if (p >= 2) asegurarCortes(); S.paso = clamp(p, 0, 4); R.err = ''; guardar(); pintarVista(); $('main').scrollTop = 0; window.scrollTo(0, 0);
}
function pintarPasos() {
  $('#pasos').innerHTML = PASOS.map((n, i) => `<button type="button" class="step ${i === S.paso ? 'on' : i < S.paso ? 'done' : ''}" data-ir="${i}" ${i === S.paso ? 'aria-current="step"' : ''}><i>${i + 1}</i><span>${n}</span></button>`).join('');
  $('#atras').hidden = S.paso === 0; const s = $('#sig'); s.hidden = S.paso === 4; s.disabled = S.paso === 1 && !S.escenas.length;
  s.textContent = ['Crear la estructura →', S.modo === 'video' ? 'Ver el montaje →' : 'El guion me gusta →', 'Seguir con las tomas →', 'Ver el montaje →', ''][S.paso];
  const L = S.escenas.length ? linea() : null;
  $('#pista').textContent = [S.ejemplo ? 'Los datos de ejemplo se pueden cambiar' : '', L ? `${S.escenas.length} escenas · unos ${Math.round(S.escenas.reduce((a, e) => a + palabras(e.frase), 0) / 2.5)} s de voz` : S.modo === 'video' ? 'Sube tus tomas y pide el montaje para seguir' : 'Genera la estructura para seguir', R.voz.limpio ? `Voz lista: ${fmt(R.voz.limpio.duration)}` : 'Puedes seguir sin voz', L ? `${S.escenas.filter(e => R.media.has(e.mediaId)).length} de ${S.escenas.length} escenas con toma` : '', ''][S.paso];
}
function pintarVista() { if (!S) return; pintarPasos(); V.innerHTML = [vIdea, vGuion, vVoz, vTomas, vMontaje][S.paso](); despues(); chat.refrescar(); }
const aviso = () => (R.ocupado ? `<div class="note" role="status"><span class="spin"></span>${esc(R.ocupado)}</div>` : '') + (R.err ? `<div class="note warn" role="alert">${esc(R.err)}</div>` : '');
const segFmt = () => `<div class="seg" role="group" aria-label="Formato">${FORMATOS.map(f => `<button type="button" data-fmt="${f[0]}" aria-pressed="${S.formato === f[0]}">${f[1]}</button>`).join('')}</div>`;

function vIdea() {
  const b = S.brief, e = ETQ[S.tipo], ph = EJ[S.tipo];
  const campo = (k, l, sm) => `<label class="f">${l}${sm ? ` <small>${sm}</small>` : ''}<input type="text" id="b-${k}" data-b="${k}" value="${esc(b[k])}" placeholder="${esc(ph[k] || '')}"></label>`;
  return `<div class="head"><span class="eyebrow">Paso 1 · La idea</span><h1>¿Qué video hacemos hoy?</h1><p class="lead">Cuéntame lo esencial. Con eso preparo la estructura del video y lo que tienes que grabar.</p></div>
  <div class="tipos">
    <button type="button" class="tipo" data-tipo="unboxing" aria-pressed="${S.tipo === 'unboxing'}"><b>Unboxing</b><span>Abres un producto, lo enseñas y das tu opinión.</span></button>
    <button type="button" class="tipo" data-tipo="lugar" aria-pressed="${S.tipo === 'lugar'}"><b>Lugar turístico</b><span>Visitas un sitio y cuentas qué ver y si vale la pena.</span></button>
  </div>
  ${S.ejemplo ? '<div class="note"><span class="tag">Ejemplo</span> Hemos rellenado un ejemplo para que veas cómo funciona. Cámbialo por lo tuyo.</div>' : ''}
  <div class="card"><div class="grid2">${campo('nombre', e.nombre)}${campo('marca', e.marca)}</div>
    <div class="f">${e.p}</div><div class="grid2">${campo('p1', '1')}${campo('p2', '2')}${campo('p3', '3')}</div>
    <div class="grid2">${campo('veredicto', e.veredicto)}${campo('dato', e.dato)}</div>${campo('cta', e.cta, 'Enlace en bio, guardar el video, un código…')}
  </div>
  <div class="card"><div class="row"><div class="grow"><b>Duración</b><div class="muted">Los videos cortos se ven hasta el final.</div></div>
    <div class="seg" role="group" aria-label="Duración">${[30, 45, 60].map(d => `<button type="button" data-dur="${d}" aria-pressed="${S.dur === d}">${d} s</button>`).join('')}</div></div>
    <div class="row"><div class="grow"><b>Formato</b><div class="muted">Vertical para Reels y TikTok, 4:5 para el feed de Instagram.</div></div>${segFmt()}</div>
  </div>
  ${S.escenas.length && !S.ejemplo ? `<div class="row"><button type="button" class="btn sm" data-act="rehacer">Rehacer la estructura con estos datos</button><span class="muted" id="rehOk"></span></div>` : ''}`;
}
function vGuion() {
  const cl = S.modo === 'claude', vf = S.modo === 'video', sinC = !ia.activa, nb = S.modo === 'base' ? S.escenas.length : S.guardadas.base ? S.guardadas.base.length : plantilla().length;
  const ph = S.tipo === 'unboxing' ? 'Ej.: un video de primeras impresiones muy rápido, que empiece con el producto ya puesto y luego vuelva atrás para abrir la caja.' : 'Ej.: la visita contada como un recorrido de la mañana a la noche, con mis tres momentos favoritos y un ambiente relajado.';
  const off = 'Disponible cuando el estudio tenga Claude activado.';
  return `<div class="head"><span class="eyebrow">Paso 2 · El guion</span><h1>Elige la estructura de tu video</h1><p class="lead">Parte de la estructura de base o describe tu idea y deja que Claude proponga otra. Después cambia las frases para que suenen a ti: cuanto más cortas, mejor.</p></div>
  <div class="tipos" role="group" aria-label="Estructura">
    <button type="button" class="tipo" data-modo="base" aria-pressed="${S.modo === 'base'}"><b>Estructura de base</b><span>${nb} escenas probadas, siguiendo el playbook.</span></button>
    <button type="button" class="tipo" data-modo="claude" aria-pressed="${cl}" ${sinC && !cl ? 'disabled' : ''}><b>✦ Estructura con Claude</b><span>${sinC ? off : 'Describe tu idea y Claude crea una estructura a medida.'}</span></button>
    <button type="button" class="tipo" data-modo="video" aria-pressed="${vf}" ${sinC && !vf ? 'disabled' : ''}><b>Sin guion · video first</b><span>${sinC ? off : 'Sube tus tomas en bruto y Claude hace el montaje.'}</span></button>
  </div>
  ${vf ? `${aviso()}${dropHtml('Toca para elegir tus tomas en bruto')}${poolHtml([...R.media.values()])}
    <div class="card"><label class="f">¿Algo que Claude deba saber? <small>Opcional: el ambiente, el plano con el que quieres empezar, lo que no debe salir.</small><textarea id="descV" rows="3" placeholder="Ej.: ambiente tranquilo, empieza por el plano del mar y no uses las tomas donde se me ve sin maquillaje.">${esc(S.descV || '')}</textarea></label>
    <div class="row"><button type="button" class="btn ${S.escenas.length ? 'soft' : 'pri'}" data-act="montar" ${sinC || R.ocupado || !R.media.size ? 'disabled' : ''}>✦ ${S.escenas.length ? 'Rehacer el montaje con Claude' : 'Hacer el montaje con Claude'}</button><span class="muted">Duración objetivo: ${S.dur} s · ${ia.coste('montaje')} créditos</span></div></div>
    ${S.escenas.length ? `<div class="card"><div class="row"><h2 class="grow">El montaje de Claude</h2><span class="muted num">${S.escenas.length} planos · ${fmt(linea().total)}</span></div><div class="lst">${S.escenas.map((e, i) => { const m = R.media.get(e.mediaId); return `<div class="li"><b class="num" style="width:24px">${i + 1}</b><div class="grow"><b>${esc(e.nombre)}</b><div class="muted">${m ? esc(m.name) : 'Toma no disponible'}${m && m.kind === 'video' ? ' · desde ' + seg(+e.inicio || 0) : ''}${e.rot !== 'none' && e.rotTxt ? ' · rótulo «' + esc(e.rotTxt) + '»' : ''}</div></div><span class="num muted">${seg((+e.fija || 0) + (+e.extra || 0))}</span></div>`; }).join('')}</div>
    <p class="muted">Pulsa «Ver el montaje» para verlo. Allí puedes pedirle cambios a Claude, retocar cada plano en el paso Tomas y añadir una voz en off en el paso Voz.</p></div>` : ''}` : ''}
  ${cl ? `<div class="card"><label class="f">Describe el video que imaginas <small>El estilo, el orden, el ambiente, lo que quieres que se recuerde. Claude usa también tus datos del paso 1.</small><textarea id="desc" rows="4" placeholder="${esc(ph)}">${esc(S.desc)}</textarea></label>
    <div class="row"><button type="button" class="btn ${S.escenas.length ? 'soft' : 'pri'}" data-act="claude" ${sinC || R.ocupado ? 'disabled' : ''}>✦ ${S.escenas.length ? 'Generar otra propuesta' : 'Generar la estructura'}</button><span class="muted">${S.escenas.length ? 'La propuesta actual se reemplaza.' : ''}</span></div></div>` : ''}
  ${vf ? '' : aviso()}
  ${R.voz.buf && S.escenas.length && !vf ? '<p class="muted">Si cambias las frases, repite la grabación de voz para que coincidan.</p>' : ''}
  ${S.escenas.length && !vf ? `<div class="lst" style="gap:14px">${S.escenas.map((e, i) => `<div class="card esc" data-id="${e.id}"><div class="n">${i + 1}</div><div class="body">
    <div class="tit"><input type="text" id="n-${e.id}" data-e="nombre" value="${esc(e.nombre)}" aria-label="Nombre de la escena"><button type="button" class="btn ico sm" data-act="sube" aria-label="Subir escena" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn ico sm" data-act="baja" aria-label="Bajar escena" ${i === S.escenas.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="btn ico sm" data-act="borra" aria-label="Quitar escena">✕</button></div>
    <label class="f">Qué grabar<input type="text" id="t-${e.id}" data-e="toma" value="${esc(e.toma)}"></label>
    <label class="f">Qué dices <small class="num" id="w-${e.id}">${palabras(e.frase)} palabras · ${seg(planDe(e))}</small><textarea id="f-${e.id}" data-e="frase">${esc(e.frase)}</textarea></label>
    <div class="grid2"><label class="f">Rótulo animado<select id="r-${e.id}" data-e="rot">${ROT.map(o => `<option value="${o[0]}" ${e.rot === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></label>
    <label class="f">Texto del rótulo<input type="text" id="x-${e.id}" data-e="rotTxt" value="${esc(e.rotTxt)}" ${e.rot === 'none' ? 'disabled' : ''}></label></div>
  </div></div>`).join('')}</div>
  <div><button type="button" class="btn" data-act="mas">+ Añadir una escena</button></div>` : ''}`;
}
function vVoz() {
  const v = R.voz, es = vozEsc();
  let h = `<div class="head"><span class="eyebrow">Paso 3 · La voz</span><h1>Graba tu voz en off</h1><p class="lead">Lee el guion con naturalidad, de una vez. No pasa nada si haces pausas o respiras: yo acorto los silencios largos sin que suene a robot.</p></div>${aviso()}`;
  if (!v.buf) {
    h += `<div class="card"><div class="tele">${es.map(e => `<p><small>${esc(e.nombre)}</small>${esc(e.frase)}</p>`).join('') || '<p class="muted">El guion no tiene frases todavía.</p>'}</div></div>
    <div class="card">${R.grab ? `<div class="row"><button type="button" class="btn rec" data-act="grabar">■ Parar y usar esta toma</button><b class="num" id="crono">0:00</b><span class="muted">Grabando…</span></div>`
      : `<div class="row">${R.micNo ? '' : '<button type="button" class="btn pri" data-act="grabar">● Grabar aquí</button>'}<button type="button" class="btn ${R.micNo ? 'pri' : ''}" data-act="subeVoz">Subir un audio</button></div>
      ${R.micNo ? '<div class="note warn">No pude usar el micrófono. Da permiso al micrófono en tu navegador, o graba el guion con las notas de voz del móvil y sube el archivo aquí.</div>' : '<p class="muted">También puedes grabar con las notas de voz del móvil y subir el archivo.</p>'}`}
    </div><div class="note">¿Prefieres un video sin voz? Sigue al paso siguiente: cada escena durará lo previsto y se oirá el sonido de tus tomas.</div>`;
    return h;
  }
  const antes = v.buf.duration, desp = v.limpio.duration, ts = tramos();
  h += `<div class="card"><div class="row"><div class="stats grow"><div><b class="num">${fmt(antes)}</b><span>tu grabación</span></div><div><b class="num">${fmt(desp)}</b><span>sin silencios largos</span></div><div><b class="num">${v.n}</b><span>pausas acortadas</span></div></div>
      <div><div class="muted" style="margin-bottom:4px">Ritmo</div><div class="seg" role="group" aria-label="Ritmo">${['Natural', 'Equilibrado', 'Dinámico'].map((n, i) => `<button type="button" data-ritmo="${i}" aria-pressed="${S.ritmo === i}">${n}</button>`).join('')}</div></div></div>
    <canvas class="onda" id="onda" aria-label="Forma de onda de tu voz; en rosa, los silencios que se acortan"></canvas>
    <p class="muted">En rosa, lo que se quita. Cada pausa conserva una respiración, y las pausas largas siguen siendo un poco más largas que las cortas.</p>
    <div class="row"><button type="button" class="btn pri" data-act="oirL">▶ Escuchar el resultado</button><button type="button" class="btn" data-act="oirO">▶ Escuchar el original</button><span class="grow"></span><button type="button" class="btn sm" data-act="quitaVoz">Grabar de nuevo</button></div></div>
  <div class="card"><h2>Tu voz, escena por escena</h2><p class="muted">He repartido la voz entre las escenas en las pausas. Escucha cada una; si empieza tarde o termina pronto, mueve su final con − y +.</p>
    <div class="lst">${ts.map(s => `<div class="li"><button type="button" class="btn ico sm" data-oir="${s.k}" aria-label="Escuchar">▶</button><div class="grow"><b>${s.e ? esc(s.e.nombre) : 'Escena borrada'}</b><div class="muted">${s.e ? esc(s.e.frase) : 'Este tramo de voz ya no se usa.'}</div></div><span class="num muted">${seg(Math.max(0, s.b - s.a))}</span>${s.k < ts.length - 1 ? `<button type="button" class="btn ico sm" data-mueve="${s.k}" data-d="-0.1" aria-label="Terminar antes">−</button><button type="button" class="btn ico sm" data-mueve="${s.k}" data-d="0.1" aria-label="Terminar después">+</button>` : ''}</div>`).join('')}</div>
    ${S.escenas.some(e => e.frase.trim() && !S.vozIds.includes(e.id)) ? '<div class="note warn">Hay escenas nuevas con frase que no están en esta grabación. Graba de nuevo para incluirlas.</div>' : ''}</div>`;
  return h;
}
const dropHtml = t => `<div class="drop" id="drop" role="button" tabindex="0"><h2>${t}</h2><span class="muted">o arrástralas aquí · videos y fotos</span></div>`;
function poolHtml(ms) {
  return ms.length ? `<div class="card"><div class="row"><h2 class="grow">Tus tomas</h2><span class="muted">${ms.length} archivo${ms.length > 1 ? 's' : ''}</span></div><div class="pool">${ms.map(m => `<figure>${m.thumb ? `<img src="${m.thumb}" alt="">` : '<div class="th"></div>'}<figcaption title="${esc(m.name)}">${m.err ? 'No se puede leer' : m.kind === 'video' ? seg(m.dur) : 'Foto'} · ${esc(m.name)}</figcaption><button type="button" class="btn sm" data-quita="${m.id}">Quitar</button></figure>`).join('')}</div>
    ${ms.some(m => m.err) ? '<div class="note warn">Algún video no se puede leer en este navegador. En el iPhone, elige «Más compatible» en Ajustes › Cámara › Formatos, o exporta el video en MP4.</div>' : ''}</div>` : '';
}
function vTomas() {
  const L = linea(), ms = [...R.media.values()], huerfanas = !ms.length && S.escenas.some(e => e.mediaId);
  return `<div class="head"><span class="eyebrow">Paso 4 · Las tomas</span><h1>Sube tus videos</h1><p class="lead">Súbelos todos a la vez. Los coloco en orden en las escenas y tú cambias lo que quieras. También puedes usar fotos.</p></div>${aviso()}
  ${huerfanas ? '<div class="note warn">Las tomas de este video no están en este dispositivo: se guardaron en otro navegador o se borraron sus datos. Vuelve a subirlas aquí.</div>' : ''}
  ${dropHtml('Toca para elegir tus tomas')}<p class="muted">Tus videos se quedan en este dispositivo: no se suben a internet.</p>${poolHtml(ms)}
  <div class="card"><h2>Qué toma va en cada escena</h2><div class="lst">${L.items.map((it, i) => {
    const e = it.e, m = R.media.get(e.mediaId), corto = m && m.kind === 'video' && m.dur > 0 && m.dur - (+e.inicio || 0) < it.dur - 0.2, maxIni = m && m.kind === 'video' ? Math.max(0, m.dur - it.dur) : 0;
    return `<div class="li toma" data-id="${e.id}">${m && m.thumb ? `<img class="th" src="${m.thumb}" alt="">` : '<div class="th vacio"></div>'}<div class="col">
      <div><b>${i + 1}. ${esc(e.nombre)}</b> <span class="num muted">· ${seg(it.dur)}</span><div class="muted">${esc(e.toma)}</div></div>
      <select id="m-${e.id}" data-e="mediaId" aria-label="Toma para ${esc(e.nombre)}"><option value="">Sin toma todavía</option>${ms.filter(x => !x.err).map(x => `<option value="${x.id}" ${x.id === e.mediaId ? 'selected' : ''}>${esc(x.name)}${x.kind === 'video' ? ' · ' + seg(x.dur) : ' · foto'}</option>`).join('')}</select>
      ${corto ? `<div class="note warn">Esta toma dura ${seg(m.dur)} y la escena ${seg(it.dur)}: la última imagen se quedará fija al final.</div>` : ''}
      <details data-det="${e.id}" ${R.abiertos.has(e.id) ? 'open' : ''}><summary>Ajustes de esta escena</summary><div class="in">
        ${m && m.kind === 'video' && maxIni > 0.2 ? `<label class="f">La toma empieza en <small class="num" id="iv-${e.id}">${seg(+e.inicio || 0)}</small><input type="range" id="i-${e.id}" data-e="inicio" min="0" max="${maxIni.toFixed(1)}" step="0.1" value="${+e.inicio || 0}"></label>` : ''}
        ${it.vd <= 0 ? `<label class="f">Duración en pantalla <small class="num" id="fv-${e.id}">${seg(+e.fija > 0 ? +e.fija : planDe(e))}</small><input type="range" id="d-${e.id}" data-e="fija" min="0.8" max="10" step="0.1" value="${+e.fija > 0 ? +e.fija : planDe(e).toFixed(1)}"></label>` : ''}
        <label class="f">Sonido de la toma <small class="num" id="sv-${e.id}">${Math.round(e.sonido * 100)} %</small><input type="range" id="s-${e.id}" data-e="sonido" min="0" max="1" step="0.05" value="${e.sonido}"></label>
        <label class="f">Respiro sin voz al final <small class="num" id="ev-${e.id}">${seg(+e.extra || 0)}</small><input type="range" id="e-${e.id}" data-e="extra" min="0" max="4" step="0.5" value="${+e.extra || 0}"></label>
      </div></details></div></div>`; }).join('')}</div></div>`;
}
function vMontaje() {
  const L = linea(), falta = S.escenas.filter(e => !R.media.has(e.mediaId)).length, x = R.exp, r = R.res, k = S.kit;
  const copia = (titulo, txt, id) => `<div class="kit"><div class="row"><b class="grow">${titulo}</b><button type="button" class="btn sm" data-copia="${id}">Copiar</button></div><p id="k-${id}">${esc(txt)}</p></div>`;
  return `<div class="head"><span class="eyebrow">Paso 5 · El montaje</span><h1>Tu video, montado</h1><p class="lead">Mira el resultado. La voz marca el ritmo, la música baja sola cuando hablas y los rótulos entran con su escena.${ia.activa ? ' Si quieres cambiar algo, pídeselo a Claude con tus palabras.' : ''}</p></div>${aviso()}
  <div class="edit"><div class="visor"><div id="lienzo"></div>
      <div class="row" style="width:100%"><button type="button" class="btn pri" id="play" data-act="play" ${x ? 'disabled' : ''}>▶ Ver</button><input type="range" id="barra" class="grow" min="0" max="${L.total.toFixed(2)}" step="0.05" value="0" aria-label="Posición" ${x ? 'disabled' : ''}><span class="num muted" id="reloj">0:00 / ${fmt(L.total)}</span></div>
      <div class="tira" id="tira">${L.items.map((it, i) => `<button type="button" data-salta="${it.ini.toFixed(2)}">${i + 1}. ${esc(it.e.nombre)}</button>`).join('')}</div></div>
    <div class="col" style="gap:16px">
      ${falta ? `<div class="note warn">Faltan tomas en ${falta} escena${falta > 1 ? 's' : ''}. Puedes verlo igual, pero esas escenas saldrán vacías.</div>` : ''}
      ${ia.activa ? `<button type="button" class="claudecta" data-act="chat"><b>✦ Edita con Claude</b><span>«Haz el gancho más corto», «quita la escena del papel», «¿qué mejorarías?»</span></button>` : ''}
      <div class="card"><h2>Acabado</h2>
        <label class="sw"><input type="checkbox" id="subt" ${S.subt ? 'checked' : ''} ${R.voz.limpio ? '' : 'disabled'}>Subtítulos con tus frases</label>
        <div class="row"><div class="grow"><b>Música de fondo</b><div class="muted">${R.musica.buf ? esc(R.musica.nombre) : 'Sube un archivo de música. Bajará sola cuando hables.'}</div></div>${R.musica.buf ? '<button type="button" class="btn sm" data-act="quitaMus">Quitar</button>' : '<button type="button" class="btn sm" data-act="subeMus">Elegir música</button>'}</div>
        ${R.musica.buf ? `<label class="f">Volumen de la música <small class="num" id="mvv">${Math.round(S.musVol * 100)} %</small><input type="range" id="mv" min="0" max="1" step="0.05" value="${S.musVol}"></label>` : ''}
        <div class="row"><div class="grow"><b>Formato</b></div>${segFmt()}</div>
        <div class="row"><div class="grow"><b>Encuadre</b><div class="muted">Si una toma no tiene la forma del video.</div></div><div class="seg" role="group" aria-label="Encuadre"><button type="button" data-enc="llenar" aria-pressed="${S.encuadre !== 'ajustar'}">Llenar</button><button type="button" data-enc="ajustar" aria-pressed="${S.encuadre === 'ajustar'}">Ver entera</button></div></div>
      </div>
      <div class="card"><h2>Crear el video</h2>
        ${x ? `<progress id="prog" value="0" max="1"></progress><div class="row"><span class="num grow" id="progTxt">0:00 de ${fmt(x.total)}</span><button type="button" class="btn sm" data-act="cancela">Cancelar</button></div><div class="note">Deja esta pantalla abierta y a la vista hasta que termine. Tarda lo mismo que dura el video.</div>`
        : r ? `<video class="res" src="${r.url}" controls playsinline></video><div class="row"><button type="button" class="btn pri" data-act="guardaVideo">Guardar video</button><button type="button" class="btn" data-act="exporta">Crear de nuevo</button></div><div class="muted num">${esc(r.nombre)} · ${r.mb.toFixed(1).replace('.', ',')} MB</div>${r.msg ? `<div class="note ok">${esc(r.msg)}</div>` : ''}${r.compat ? '' : `<div class="note warn">${AVISO_FORMATO}</div>`}`
        : `<p class="muted">Se graba el montaje completo de ${fmt(L.total)}, con voz, música, rótulos y subtítulos.</p>${puedeExportar() ? '' : '<div class="note warn">Este navegador no puede crear el video. Abre el estudio en Chrome o Safari actualizados.</div>'}<div><button type="button" class="btn pri" data-act="exporta" ${L.total <= 0 || !puedeExportar() ? 'disabled' : ''}>Crear mi video</button></div>`}
      </div>
      <div class="card"><h2>Para publicar</h2>
        ${k ? `${copia('Instagram', k.instagram + '\n\n' + k.hashtags.map(h => '#' + h).join(' '), 'ig')}${copia('TikTok', k.tiktok + ' ' + k.hashtags.slice(0, 4).map(h => '#' + h).join(' '), 'tt')}${copia('Título para Shorts', k.titulo_corto, 'yt')}
          ${k.ganchos.length ? `<div class="kit"><b>Otros ganchos para probar</b><ul>${k.ganchos.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
          <div class="kit"><label class="f">Texto de la portada<input type="text" id="portTxt" value="${esc(k.portada)}"></label></div>` : '<p class="muted">Claude escribe la descripción, los hashtags y el texto de la portada a partir de tu guion.</p>'}
        <div class="row">${ia.activa ? `<button type="button" class="btn ${k ? '' : 'soft'}" data-act="kit" ${R.kitOcupado ? 'disabled' : ''}>${R.kitOcupado ? '<span class="spin"></span>Escribiendo…' : k ? 'Escribir otra versión' : '✦ Preparar los textos'}</button>` : ''}<button type="button" class="btn" data-act="portada" ${L.total <= 0 ? 'disabled' : ''}>Descargar la portada</button></div>
        <p class="muted">La portada usa la imagen que ves ahora en el visor: mueve la barra hasta tu mejor plano.</p>
      </div>
    </div></div>`;
}
function onda() {
  const c = $('#onda'), v = R.voz; if (!c || !v.buf) return; const w = c.clientWidth, h = 96, d = window.devicePixelRatio || 1; c.width = w * d; c.height = h * d; const x = c.getContext('2d'); x.scale(d, d);
  const N = v.buf.length, ch = v.buf.getChannelData(0);
  if (!v.picos || v.picos.length !== w) { v.picos = new Float32Array(w); const st = Math.max(1, Math.floor(N / w / 200)); for (let i = 0; i < w; i++) { let m = 0; const a = Math.floor(i * N / w), b = Math.floor((i + 1) * N / w); for (let j = a; j < b; j += st) { const y = Math.abs(ch[j]); if (y > m) m = y; } v.picos[i] = m; } }
  let mx = 0.05; for (const p of v.picos) if (p > mx) mx = p; x.fillStyle = '#f2c9d4'; let prev = 0; for (const k of v.keeps) { if (k[0] > prev) x.fillRect(prev / N * w, 0, (k[0] - prev) / N * w, h); prev = k[1]; } if (prev < N) x.fillRect(prev / N * w, 0, (N - prev) / N * w, h);
  let ki = 0; for (let i = 0; i < w; i++) { const s = (i + 0.5) * N / w; while (ki < v.keeps.length - 1 && s > v.keeps[ki][1]) ki++; const dentro = s >= v.keeps[ki][0] && s <= v.keeps[ki][1]; x.fillStyle = dentro ? '#7a2440' : '#d98ba3'; const y = Math.max(1, v.picos[i] / mx * (h - 12)); x.fillRect(i, (h - y) / 2, 1, y); }
}
function despues() {
  if (S.paso === 2) onda();
  if (S.paso === 4) { $('#lienzo').append(motor.cv); if (!R.exp) motor.mostrar(Math.min(motor.t, Math.max(0, linea().total - 0.05))); }
}

/* ---------- events ---------- */
function alClick(ev) {
  const t = ev.target.closest('button,[role=button]'); if (!t || !S) return;
  if (t.id === 'sig') return irA(S.paso === 1 && S.modo === 'video' ? 4 : S.paso + 1); if (t.id === 'atras') return irA(S.paso - 1);
  if (t.closest('#pasos') && t.dataset.ir) return irA(+t.dataset.ir);
  if (!V.contains(t)) return;
  const d = t.dataset, card = t.closest('[data-id]'), e = card && S.escenas.find(x => x.id === card.dataset.id), i = e ? S.escenas.indexOf(e) : -1;
  if (t.id === 'drop') return $('#fMedia').click();
  if (d.tipo) { if (d.tipo !== S.tipo) { S.tipo = d.tipo; if (S.ejemplo) { S.brief = { ...EJ[S.tipo] }; S.escenas = []; } else S.briefCambiado = true; guardar(); } return pintarVista(); }
  if (d.modo) return cambiarModo(d.modo);
  if (d.dur) { S.dur = +d.dur; guardar(); return pintarVista(); }
  if (d.fmt) { detener(); S.formato = d.fmt; guardar(); return pintarVista(); }
  if (d.enc) { detener(); S.encuadre = d.enc; guardar(); return pintarVista(); }
  if (d.ritmo) { pararOir(); S.ritmo = +d.ritmo; procesarVoz(); guardar(); return pintarVista(); }
  if (d.oir) { const s = tramos()[+d.oir]; return s && oir(R.voz.limpio, 'l' + s.a, s.a, s.b); }
  if (d.mueve) { const k = +d.mueve, lo = (k === 0 ? 0 : S.cortes[k - 1]) + 0.3, hi = (k === S.cortes.length - 1 ? R.voz.limpio.duration : S.cortes[k + 1]) - 0.3; S.cortes[k] = clamp(S.cortes[k] + +d.d, lo, hi); pararOir(); guardar(); return pintarVista(); }
  if (d.quita) return quitarMedia(d.quita);
  if (d.salta) { const x = +d.salta + 0.01; if (motor.sonando) motor.reproducir(x); else motor.mostrar(x); return; }
  if (d.copia) return copiar($('#k-' + d.copia).textContent);
  const reordena = () => { S.guionEditado = true; guardar(); pintarVista(); };
  switch (d.act) {
    case 'rehacer': if (S.modo !== 'base') { S.guardadas[S.modo] = S.escenas; S.modo = 'base'; } S.guardadas.base = null; S.escenas = plantilla(); S.cortes = []; S.vozIds = []; S.guionEditado = false; S.briefCambiado = false; guardar(); $('#rehOk').textContent = 'Hecho. Mira el paso Guion.'; break;
    case 'claude': conClaude(); break;
    case 'montar': montajeClaude(); break;
    case 'sube': if (i > 0) { S.escenas.splice(i - 1, 0, S.escenas.splice(i, 1)[0]); reordena(); } break;
    case 'baja': if (i >= 0 && i < S.escenas.length - 1) { S.escenas.splice(i + 1, 0, S.escenas.splice(i, 1)[0]); reordena(); } break;
    case 'borra': if (i >= 0) { S.escenas.splice(i, 1); motor.olvidar(e.id); reordena(); } break;
    case 'mas': S.escenas.push(nuevaEsc({ nombre: 'Nueva escena' })); reordena(); break;
    case 'grabar': grabar(); break; case 'subeVoz': $('#fVoz').click(); break; case 'quitaVoz': quitarVoz(); break;
    case 'oirL': oir(R.voz.limpio, 'l0', 0); break; case 'oirO': oir(R.voz.buf, 'o0', 0); break;
    case 'subeMus': $('#fMus').click(); break; case 'quitaMus': detener(); R.musica = { buf: null, nombre: '' }; idb.del(clave('musica')); pintarVista(); break;
    case 'play': if (motor.sonando) { detener(); motor.mostrar(motor.t); } else motor.reproducir(motor.t); break;
    case 'exporta': exportar(); break; case 'cancela': motor.cancelar(); break; case 'guardaVideo': guardarVideo(); break;
    case 'kit': kitPublicacion(); break; case 'portada': portada(); break;
    case 'chat': chat.abrir(); break;
  }
}
function alInput(ev) {
  const t = ev.target, d = t.dataset; if (!S || !V.contains(t)) return;
  if (d.b) { S.brief[d.b] = t.value; S.ejemplo = false; S.briefCambiado = true; guardar(); return; }
  if (t.id === 'desc') { S.desc = t.value; guardar(); return; }
  if (t.id === 'descV') { S.descV = t.value; guardar(); return; }
  if (t.id === 'portTxt') { if (S.kit) { S.kit.portada = t.value; guardar(); } return; }
  if (t.id === 'barra') { if (motor.sonando) detener(); motor.mostrar(+t.value); return; }
  if (t.id === 'mv') { S.musVol = +t.value; $('#mvv').textContent = Math.round(S.musVol * 100) + ' %'; guardar(); if (motor.sonando) motor.reproducir(motor.t); return; }
  if (t.id === 'subt') { S.subt = t.checked; guardar(); if (!motor.sonando) motor.mostrar(motor.t); return; }
  const card = t.closest('[data-id]'), e = card && S.escenas.find(x => x.id === card.dataset.id); if (!e || !d.e) return;
  if (['inicio', 'sonido', 'extra', 'fija'].includes(d.e)) { e[d.e] = +t.value; const el = $('#' + { inicio: 'iv', sonido: 'sv', extra: 'ev', fija: 'fv' }[d.e] + '-' + e.id); if (el) el.textContent = d.e === 'sonido' ? Math.round(e.sonido * 100) + ' %' : seg(+t.value); }
  else { e[d.e] = t.value; if (d.e === 'mediaId') { e.inicio = 0; } else S.guionEditado = true; }
  if (d.e === 'frase') { $('#w-' + e.id).textContent = `${palabras(e.frase)} palabras · ${seg(planDe(e))}`; S.cortes = []; S.vozIds = []; pintarPasos(); }
  guardar();
}
function alChange(ev) {
  const t = ev.target; if (!S) return;
  if (t.id === 'fVoz' && t.files[0]) { ponerVoz(t.files[0], t.files[0].name); t.value = ''; }
  else if (t.id === 'fMedia' && t.files.length) { subirTomas(t.files); t.value = ''; }
  else if (t.id === 'fMus' && t.files[0]) { const f = t.files[0]; t.value = ''; R.ocupado = 'Preparando la música…'; pintarVista(); decodificar(f).then(b => { R.musica = { buf: b, nombre: f.name }; idb.put(clave('musica'), { blob: f, name: f.name }); }).catch(() => { R.err = 'No pude leer esta música. Prueba con un archivo .mp3 o .m4a.'; }).finally(() => { R.ocupado = ''; pintarVista(); }); }
  else if (V.contains(t) && ['mediaId', 'rot', 'extra', 'fija'].includes(t.dataset.e)) pintarVista();
}

/* ---------- open / close a project ---------- */
export async function montar({ id }) {
  V = $('#vista'); PID = id; S = null;
  V.innerHTML = '<div class="note" role="status"><span class="spin"></span>Abriendo tu video…</div>';
  const { proyecto } = await api('/projects/' + id);
  S = Object.assign(estadoNuevo(), proyecto.estado || {}); if (!S.guardadas) S.guardadas = { base: null, claude: null, video: null }; if (!Array.isArray(S.vozIds)) S.vozIds = []; if (!Array.isArray(S.chat)) S.chat = [];
  // the saved state is plain data: keep ids and numbers in the shape the screens expect
  const limpia = es => (Array.isArray(es) ? es : []).filter(e => e && typeof e === 'object').map(e => nuevaEsc({ ...e, id: String(e.id || uid()).replace(/[^\w-]/g, '') || uid(), mediaId: String(e.mediaId || '').replace(/[^\w-]/g, ''), sonido: clamp(+e.sonido || 0, 0, 1), extra: clamp(+e.extra || 0, 0, 4), fija: clamp(+e.fija || 0, 0, 30), inicio: Math.max(0, +e.inicio || 0), frase: String(e.frase ?? ''), nombre: String(e.nombre ?? ''), toma: String(e.toma ?? ''), rotTxt: String(e.rotTxt ?? ''), rot: ROT.some(r => r[0] === e.rot) ? e.rot : 'none' }));
  S.escenas = limpia(S.escenas); for (const k of ['base', 'claude', 'video']) if (S.guardadas[k]) S.guardadas[k] = limpia(S.guardadas[k]);
  S.paso = clamp(Math.round(+S.paso || 0), 0, 4); S.dur = [30, 45, 60].includes(+S.dur) ? +S.dur : 45; S.ritmo = [0, 1, 2].includes(+S.ritmo) ? +S.ritmo : 1; S.musVol = clamp(+S.musVol || 0, 0, 1);
  if (!TAMANOS[S.formato]) S.formato = '9x16'; if (!ETQ[S.tipo]) S.tipo = 'unboxing'; if (!['base', 'claude', 'video'].includes(S.modo)) S.modo = 'base';
  S.cortes = (Array.isArray(S.cortes) ? S.cortes : []).map(Number).filter(isFinite); S.brief = Object.assign({ nombre: '', marca: '', p1: '', p2: '', p3: '', veredicto: '', dato: '', cta: '' }, S.brief);
  if (S.kit && !(Array.isArray(S.kit.hashtags) && Array.isArray(S.kit.ganchos))) S.kit = null;
  R = { voz: vozVacia(), musica: { buf: null, nombre: '' }, media: new Map(), micNo: false, abiertos: new Set(), grab: null, err: '', ocupado: '', exp: null, res: null, deshacer: [], limpio: false, kitOcupado: false };
  document.body.dataset.modo = 'estudio'; motor.t = 0;
  motor.usar(composicion, { alTiempo: uiTiempo, alCambiarEscena: i => $$('#tira button').forEach((b, k) => b.classList.toggle('on', k === i)), alReproducir: on => { const b = $('#play'); if (b) b.textContent = on ? '❚❚ Pausa' : '▶ Ver'; } });
  chat.conectar({ estado: () => S, contexto: contextoChat, aplicar: aplicarOps, deshacer, puedeDeshacer: () => R.deshacer.length > 0, guardar });
  ac = new AbortController(); const o = { signal: ac.signal };
  document.addEventListener('click', alClick, o); document.addEventListener('input', alInput, o); document.addEventListener('change', alChange, o);
  document.addEventListener('keydown', ev => { if (ev.target.id === 'drop' && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); $('#fMedia').click(); } }, o);
  ['dragover', 'dragleave', 'drop'].forEach(n => document.addEventListener(n, ev => { const z = ev.target.closest && ev.target.closest('#drop'); if (!z) return; ev.preventDefault(); z.classList.toggle('over', n === 'dragover'); if (n === 'drop' && ev.dataTransfer.files.length) subirTomas(ev.dataTransfer.files); }, o));
  document.addEventListener('toggle', ev => { const d = ev.target.dataset && ev.target.dataset.det; if (d) { if (ev.target.open) R.abiertos.add(d); else R.abiertos.delete(d); } }, { capture: true, signal: ac.signal });
  window.addEventListener('resize', () => { if (S && S.paso === 2) onda(); }, o);
  window.addEventListener('pagehide', () => guardarYa(true), o);
  pintarVista();
  try { await Promise.all([document.fonts.load('600 80px "Cormorant Garamond"'), document.fonts.load('italic 500 80px "Cormorant Garamond"'), document.fonts.load('600 40px "DM Sans"')]); } catch {}
  // bring back this project's media from this device
  const ks = (await idb.claves(PID)) || []; if (!ks.length || PID !== id) return;
  R.ocupado = 'Recuperando tus tomas…'; pintarVista();
  for (const k of ks) {
    const v = await idb.get(k); if (!v || !v.blob || PID !== id || !S) continue; const nombre = String(k).slice(id.length + 1);
    try {
      if (nombre === 'voz') { R.voz.buf = await decodificar(v.blob); R.voz.nombre = v.name; procesarVoz(true); }
      else if (nombre === 'musica') R.musica = { buf: await decodificar(v.blob), nombre: v.name };
      else if (nombre.startsWith('m/')) { const m = await cargarMedia(new File([v.blob], v.name, { type: v.blob.type }), nombre.slice(2)); R.media.set(m.id, m); }
    } catch {}
  }
  if (PID === id && S) { R.ocupado = ''; pintarVista(); }
}
export function desmontar() {
  if (ac) ac.abort(); guardarYa(); pararOir(); if (R && R.grab) try { R.grab.rec.stop(); } catch {}
  motor.cancelar(); motor.vaciar(); chat.desconectar();
  if (R) { R.media.forEach(m => URL.revokeObjectURL(m.url)); if (R.res) URL.revokeObjectURL(R.res.url); }
  S = null; R = null; PID = ''; delete document.body.dataset.modo; $('#pasos').innerHTML = '';
}
