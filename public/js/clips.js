// Extractos: drop in a long video, get its best short moments, ready to post.
// How it finds them, all without uploading the video:
//   1. the sound is measured on this device (silences, loudness) and, if the studio has
//      speech-to-text, transcribed with word timings;
//   2. one frame every few seconds goes to Claude as contact sheets, with the transcript;
//   3. Claude picks the moments; a second pass with one frame per second places each cut;
//   4. cuts are snapped to the nearest word boundary or silence so no clip starts mid-word.
import { $, esc, fmt, seg, uid, clamp, slug, guardarArchivo, copiar, descargar, zip, esMovil } from './util.js';
import { api, ia, mensajeDe } from './api.js';
import { idb, pedirPersistencia } from './idb.js';
import { decodificar, medir, wav16 } from './audio.js';
import { cargarMedia, abrirVideo, soltar, hojasTiempo, cuadro } from './media.js';
import { motor, TAMANOS, puedeExportar, AVISO_FORMATO } from './render.js';

const FORMATOS = [['9x16', '9:16'], ['4x5', '4:5'], ['1x1', '1:1'], ['16x9', '16:9']];
const LARGOS = [[5, 10, '5 a 10 s'], [10, 20, '10 a 20 s'], [20, 40, '20 a 40 s']];
export const estadoNuevo = () => ({ v: 1, video: null, contexto: '', cuantos: 6, min: 5, max: 10, formato: '9x16', encuadre: 'llenar', subt: true, gancho: true, resumen: '', clips: [], palabras: [], analizado: false });

let S = null, R = null, PID = '', V = null, ac = null, tSave = 0, sucio = false;
const clave = k => PID + '/' + k;
function guardarYa(keepalive) {
  clearTimeout(tSave); if (!sucio || !S) return; sucio = false;
  const nombre = S.video ? S.video.nombre.replace(/\.[a-z0-9]+$/i, '') : 'Extractos sin título';
  api('/projects/' + PID, { method: 'PUT', keepalive, body: { nombre, estado: S, ...(keepalive ? {} : { mini: (S.clips[0] && S.clips[0].mini) || (R.m && R.m.thumb) || '' }) } }).catch(() => { sucio = true; });
}
function guardar() { sucio = true; clearTimeout(tSave); tSave = setTimeout(() => guardarYa(), 800); }

/* ---------- the long video ---------- */
async function ponerVideo(file, persistir = true) {
  R.err = ''; R.ocupado = 'Abriendo el video…'; pintar();
  const m = await cargarMedia(file, 'video');
  if (m.err || m.kind !== 'video' || !(m.dur > 0)) { R.ocupado = ''; R.err = 'No puedo leer este video en este navegador. En el iPhone, elige «Más compatible» en Ajustes › Cámara › Formatos, o conviértelo a MP4.'; URL.revokeObjectURL(m.url); return pintar(); }
  if (R.m) { motor.vaciar(); URL.revokeObjectURL(R.m.url); }
  R.m = m; const mismo = S.video && Math.abs(S.video.dur - m.dur) < 0.5;
  if (!mismo) { S.clips = []; S.palabras = []; S.resumen = ''; S.analizado = false; }
  S.video = { nombre: m.name, dur: m.dur, w: m.w, h: m.h, size: m.size };
  if (persistir) { pedirPersistencia(); idb.put(clave('video'), { blob: file, name: m.name }); guardar(); }
  R.activo = S.clips[0] ? S.clips[0].id : ''; R.ocupado = ''; pintar();
}

/* ---------- finding the moments ---------- */
const FASES = { audio: 'Escuchando el sonido', stt: 'Transcribiendo lo que se dice', frames: 'Mirando el video', claude: 'Claude elige los mejores momentos', afinar: 'Afinando cada corte', listo: 'Preparando los clips' };
function fase(k, detalle = '') { R.fase = k; R.detalle = detalle; const el = $('#fases'); if (el) el.innerHTML = fasesHtml(); }
const fasesHtml = () => { const ks = R.fasesActivas, i = ks.indexOf(R.fase); return ks.map((k, j) => `<li class="${j < i ? 'ok' : j === i ? 'on' : ''}">${j === i ? '<span class="spin"></span>' : j < i ? '✓ ' : ''}${FASES[k]}${j === i && R.detalle ? ` <span class="muted num">${esc(R.detalle)}</span>` : ''}</li>`).join(''); };

// Moves a cut to the closest clean point: a word boundary if there is a transcript, else a silence.
function ajustar(c) {
  const dur = S.video.dur, ws = S.palabras, sil = R.silencios || [];
  if (ws.length) {
    let mi = null, mf = null;
    ws.forEach((w, i) => {
      const antes = i ? w.a - ws[i - 1].b : 9, despues = i < ws.length - 1 ? ws[i + 1].a - w.b : 9;
      const di = Math.abs(w.a - c.inicio) - Math.min(antes, 0.6), df = Math.abs(w.b - c.fin) - Math.min(despues, 0.6);
      if (Math.abs(w.a - c.inicio) <= 1.2 && (mi === null || di < mi.d)) mi = { d: di, t: w.a };
      if (Math.abs(w.b - c.fin) <= 1.2 && (mf === null || df < mf.d)) mf = { d: df, t: w.b };
    });
    if (mi) c.inicio = mi.t - 0.12; if (mf) c.fin = mf.t + 0.2;
  } else if (sil.length) {
    let mi = null, mf = null;
    for (const s of sil) { const di = Math.abs(s.b - c.inicio), df = Math.abs(s.a - c.fin); if (di <= 0.8 && (!mi || di < mi.d)) mi = { d: di, t: s.b }; if (df <= 0.9 && (!mf || df < mf.d)) mf = { d: df, t: s.a }; }
    if (mi) c.inicio = mi.t - 0.1; if (mf) c.fin = mf.t + 0.15;
  }
  c.inicio = +clamp(c.inicio, 0, Math.max(0, dur - 1)).toFixed(2); c.fin = +clamp(c.fin, c.inicio + 1, dur).toFixed(2);
  if (c.fin - c.inicio > S.max + 1.5) c.fin = +(c.inicio + S.max).toFixed(2);
}

async function buscar() {
  const m = R.m; if (!m || R.buscando) return;
  motor.detener(); R.buscando = true; R.err = ''; R.nota = ''; R.res = []; R.silencios = [];
  const limite = esMovil ? 350e6 : 1.6e9, conAudio = m.size <= limite;
  R.fasesActivas = [...(conAudio ? ['audio'] : []), ...(conAudio && ia.transcribe ? ['stt'] : []), 'frames', 'claude', 'afinar', 'listo'];
  R.fase = R.fasesActivas[0]; pintar();
  let v = null;
  try {
    // 1. the sound, decoded small (16 kHz) so a long video fits in memory
    let perfil = '', palabras = [];
    if (conAudio) {
      fase('audio');
      let buf = null; try { buf = await decodificar(m.file, 16000); } catch { R.nota = 'No pude leer el sonido de este video: elijo los momentos solo por la imagen.'; }
      if (buf) {
        const md = medir(buf); R.silencios = md.silencios; perfil = md.plano ? '' : md.perfil;
        if (ia.transcribe && !md.plano) {
          fase('stt');
          try { const wav = wav16(buf); if (wav.byteLength < 76e6) palabras = (await ia.transcribir(wav)).palabras || []; else R.nota = 'El video es muy largo para transcribirlo: elijo los momentos por la imagen y el sonido.'; }
          catch (e) { if (e && e.code === 'no_credits') throw e; R.nota = 'No se pudo transcribir esta vez: elijo los momentos por la imagen y el sonido.'; }
        }
      }
    } else R.nota = 'El video pesa mucho para analizar su sonido en este dispositivo: elijo los momentos solo por la imagen.';
    // 2. one frame every few seconds
    fase('frames'); v = await abrirVideo(m.url); if (!v) throw { message: 'No pude leer las imágenes de este video.' };
    const n = clamp(Math.round(m.dur / 4), 12, 240), paso = m.dur / n, tiempos = Array.from({ length: n }, (_, i) => +((i + 0.5) * paso).toFixed(2));
    const hojas = await hojasTiempo(v, m, tiempos, { progreso: (a, b) => fase('frames', `${a} de ${b}`) });
    // 3. Claude chooses
    fase('claude');
    const d = await ia.pedir('extractos', { video: { nombre: m.name, dur: m.dur }, contexto: S.contexto, cuantos: S.cuantos, min: S.min, max: S.max, hojas, palabras, energia: perfil, paso: +paso.toFixed(1) });
    const clips = d.extractos.map(x => ({ id: uid(), inicio: x.inicio, fin: x.fin, titulo: x.titulo, gancho: x.gancho, motivo: x.motivo, puntuacion: x.puntuacion, descripcion: x.descripcion, sel: true, foco: 0.5, mini: '' }));
    S.palabras = palabras.length > 9000 ? palabras.filter(w => clips.some(c => w.b > c.inicio - 8 && w.a < c.fin + 8)) : palabras;
    // 4. second look, one frame per second around each moment
    fase('afinar');
    try {
      const pedidos = [], tiras = [];
      for (const [i, c] of clips.entries()) {
        const desde = Math.max(0, c.inicio - 3), hasta = Math.min(m.dur, c.fin + 3), k = Math.min(20, Math.max(4, Math.round(hasta - desde))), ts = Array.from({ length: k }, (_, j) => +(desde + (j + 0.5) * (hasta - desde) / k).toFixed(1));
        tiras.push((await hojasTiempo(v, m, ts, { titulo: `Clip ${c.id}`, decimales: 1 }))[0]); pedidos.push({ id: c.id, titulo: c.titulo, inicio: c.inicio, fin: c.fin, desde, hasta });
        fase('afinar', `${i + 1} de ${clips.length}`);
      }
      const f = await ia.pedir('afinar', { video: { dur: m.dur }, min: S.min, max: S.max, clips: pedidos, hojas: tiras, palabras: S.palabras });
      for (const x of f.clips || []) { const c = clips.find(k => k.id === x.id); if (c) { c.inicio = x.inicio; c.fin = x.fin; } }
    } catch (e) { if (!R.nota) R.nota = 'No pude afinar los cortes esta vez: revisa el principio y el final de cada clip.'; }
    // 5. clean cut points and a thumbnail each
    fase('listo');
    for (const c of clips) { ajustar(c); c.mini = await cuadro(v, m, c.inicio + Math.min(1, (c.fin - c.inicio) / 3), 120, 213); }
    S.clips = clips; S.resumen = d.resumen || ''; S.analizado = true; R.activo = clips[0] ? clips[0].id : ''; guardar();
  } catch (e) { R.err = mensajeDe(e); }
  if (v) soltar(v);
  R.buscando = false; R.fase = ''; motor.t = 0; pintar();
}

/* ---------- composition: one clip, or the chosen clips joined ---------- */
function subsClip(c) {
  const ws = S.palabras.filter(w => w.a >= c.inicio - 0.05 && w.b <= c.fin + 0.3); if (!ws.length) return [];
  const grupos = []; let g = [];
  for (const w of ws) { const txt = [...g.map(x => x.t), w.t].join(' '); if (g.length && (txt.length > 24 || g.length >= 4 || w.a - g[g.length - 1].b > 0.5)) { grupos.push(g); g = []; } g.push(w); }
  if (g.length) grupos.push(g);
  return grupos.map((x, i) => ({ a: Math.max(0, x[0].a - c.inicio), b: (grupos[i + 1] ? Math.min(grupos[i + 1][0].a, x[x.length - 1].b + 0.6) : x[x.length - 1].b + 0.4) - c.inicio, tx: x.map(w => w.t).join(' ') }));
}
function composicion() {
  const [W, H] = TAMANOS[S.formato] || TAMANOS['9x16'], lista = R.cola || [S.clips.find(c => c.id === R.activo)].filter(Boolean); let t = 0;
  const items = lista.map((c, i) => { const dur = Math.max(0.5, c.fin - c.inicio), it = { key: lista.length > 1 ? 'c' + i : 'clip', nombre: c.titulo, ini: t, dur, m: R.m, inicio: c.inicio, sonido: 1, foco: c.foco ?? 0.5, rot: S.gancho && c.gancho ? 'titulo' : 'none', rotTxt: c.gancho, rotDur: 3.2, ojo: '', alt: i % 2, subs: subsClip(c), vozA: 0, vozDur: 0, falta: 'Elige de nuevo el video para ver este clip' }; t += dur; return it; });
  return { W, H, total: t, encuadre: S.encuadre, subt: S.subt, voz: null, musica: null, items };
}
function uiTiempo(t, total) { const s = $('#barra'), l = $('#reloj'); if (s) { s.max = total.toFixed(2); s.value = t; } if (l) l.textContent = seg(t) + ' / ' + seg(total); }

async function crear(unidos) {
  const lista = S.clips.filter(c => c.sel).sort((a, b) => a.inicio - b.inicio); if (!lista.length || motor.exportando) return;
  R.res.forEach(r => URL.revokeObjectURL(r.url)); R.res = []; R.err = '';
  const base = slug(S.video.nombre.replace(/\.[a-z0-9]+$/i, '')), tandas = unidos ? [lista] : lista.map(c => [c]);
  try {
    for (const [i, tanda] of tandas.entries()) {
      R.cola = tanda; R.exp = { i: i + 1, n: tandas.length }; pintar();
      const r = await motor.exportar((t, tot) => { const p = $('#prog'); if (p) p.value = t / tot; });
      if (!r) break;
      R.res.push({ ...r, url: URL.createObjectURL(r.blob), nombre: unidos ? `${base}-mejores-momentos-${S.formato}.${r.ext}` : `${base}-${String(i + 1).padStart(2, '0')}-${slug(tanda[0].titulo)}.${r.ext}`, titulo: unidos ? 'Los mejores momentos' : tanda[0].titulo, mb: r.blob.size / 1048576 });
    }
  } catch (e) { R.err = mensajeDe(e); }
  R.cola = null; R.exp = null; motor.t = 0; pintar();
}

/* ---------- view ---------- */
const aviso = () => (R.ocupado ? `<div class="note" role="status"><span class="spin"></span>${esc(R.ocupado)}</div>` : '') + (R.err ? `<div class="note warn" role="alert">${esc(R.err)}</div>` : '') + (R.nota ? `<div class="note">${esc(R.nota)}</div>` : '');
const segBtns = (lista, attr, actual, nombre) => `<div class="seg" role="group" aria-label="${nombre}">${lista.map(o => `<button type="button" data-${attr}="${o[0]}" aria-pressed="${String(actual) === String(o[0])}">${o[1]}</button>`).join('')}</div>`;
const coste = () => ia.coste('extractos') + ia.coste('afinar') + (ia.transcribe ? ia.coste('transcribir') : 0);

function pintar() {
  if (!S) return; const m = R.m, cab = `<div class="head"><span class="eyebrow">Extractos</span><h1>${S.analizado ? 'Tus mejores momentos' : 'De un video largo, tus mejores momentos'}</h1><p class="lead">${S.analizado ? 'Mira cada clip, ajusta lo que quieras y crea los que te gusten. Cada uno sale listo para publicar.' : 'Sube el video entero. Claude lo mira de principio a fin y saca los momentos que mejor funcionan solos, cortados sin partir una frase.'}</p></div>`;
  if (!S.video || (!m && !S.analizado)) {
    V.innerHTML = `${cab}${aviso()}${!ia.activa ? '<div class="note warn">Para buscar los mejores momentos, el estudio necesita tener Claude activado.</div>' : ''}
      <div class="drop" id="drop" role="button" tabindex="0"><h2>Toca para elegir tu video</h2><span class="muted">o arrástralo aquí · una vlog, una visita, un unboxing completo</span></div>
      <p class="muted">Tu video se queda en este dispositivo: a Claude solo le llegan imágenes pequeñas y, si hay, el texto de lo que dices.</p>`;
    return;
  }
  if (R.buscando) { V.innerHTML = `${cab}<div class="card"><h2>Buscando en ${esc(S.video.nombre)}</h2><ul class="fases" id="fases">${fasesHtml()}</ul><p class="muted">Deja esta pantalla abierta. Un video de ocho minutos tarda uno o dos minutos.</p></div>`; return; }
  if (!S.analizado) {
    V.innerHTML = `${cab}${aviso()}
      <div class="card"><div class="row"><img class="th chico" src="${m.thumb}" alt=""><div class="grow"><b>${esc(m.name)}</b><div class="muted num">${fmt(m.dur)} · ${(m.size / 1048576).toFixed(0)} MB</div></div><button type="button" class="btn sm" data-act="otro">Cambiar de video</button></div></div>
      <div class="card"><label class="f">¿De qué va el video? <small>Opcional, pero ayuda: el producto o el lugar, lo que más te importa que salga, lo que no quieres.</small><textarea id="contexto" rows="3" placeholder="Ej.: mi visita al Castillo de San Felipe. Me interesan las vistas, los túneles y mi consejo del final.">${esc(S.contexto)}</textarea></label>
        <div class="row"><div class="grow"><b>¿Cuántos clips?</b></div>${segBtns([[3, '3'], [6, '6'], [9, '9'], [12, '12']], 'cuantos', S.cuantos, 'Cuántos clips')}</div>
        <div class="row"><div class="grow"><b>Duración de cada clip</b></div>${segBtns(LARGOS.map(l => [l[0], l[2]]), 'largo', S.min, 'Duración')}</div>
        <div class="row"><button type="button" class="btn pri" data-act="buscar" ${ia.activa ? '' : 'disabled'}>✦ Buscar los mejores momentos</button><span class="muted">${ia.activa ? `${coste()} créditos${ia.transcribe ? ' · con transcripción' : ''}` : 'Claude no está activado.'}</span></div></div>`;
    return;
  }
  const c = S.clips.find(k => k.id === R.activo), n = S.clips.filter(k => k.sel).length, x = R.exp, [W, H] = TAMANOS[S.formato], recorta = m && S.encuadre === 'llenar' && m.w / m.h > W / H + 0.05;
  const cortes = (k, etq) => `<div class="corte"><span><b>${etq}</b> <span class="num muted">${fmt(c[k])}<small>,${String(Math.floor((c[k] % 1) * 10))}</small></span></span><div class="row">${[-1, -0.2, 0.2, 1].map(d => `<button type="button" class="btn sm" data-mueve="${k}" data-d="${d}" aria-label="${etq} ${d > 0 ? 'más tarde' : 'antes'} ${Math.abs(d)} s">${d > 0 ? '+' : '−'}${String(Math.abs(d)).replace('.', ',')} s</button>`).join('')}</div></div>`;
  const ajustes = () => `<div class="ajustes"><div class="grid2"><label class="f">Título<input type="text" data-c="titulo" value="${esc(c.titulo)}"></label><label class="f">Texto en pantalla<input type="text" data-c="gancho" value="${esc(c.gancho)}"></label></div>
        <div class="grid2">${cortes('inicio', 'Empieza en')}${cortes('fin', 'Termina en')}</div>
        ${recorta ? `<label class="f">Encuadre <small>Mueve la imagen a izquierda o derecha.</small><input type="range" data-c="foco" min="0" max="1" step="0.02" value="${c.foco ?? 0.5}"></label>` : ''}
        ${c.descripcion ? `<div class="kit"><div class="row"><b class="grow">Texto para publicar</b><button type="button" class="btn sm" data-act="copia">Copiar</button></div><p id="descClip">${esc(c.descripcion)}</p></div>` : ''}</div>`;
  V.innerHTML = `${cab}${aviso()}${!m ? '<div class="note warn">El video no está en este dispositivo. Elígelo de nuevo para ver y crear los clips. <button type="button" class="btn sm" data-act="otro">Elegir el video</button></div>' : ''}
  ${S.resumen ? `<p class="muted">${esc(S.resumen)}</p>` : ''}
  <div class="edit"><div class="visor"><div id="lienzo"></div>
      <div class="row" style="width:100%"><button type="button" class="btn pri" id="play" data-act="play" ${x || !m ? 'disabled' : ''}>▶ Ver</button><input type="range" id="barra" class="grow" min="0" max="${c ? (c.fin - c.inicio).toFixed(2) : 1}" step="0.05" value="0" aria-label="Posición" ${x ? 'disabled' : ''}><span class="num muted" id="reloj"></span></div>
</div>
    <div class="col" style="gap:16px">
      <div class="lst clips">${S.clips.map((k, i) => `<div class="clip ${k.id === R.activo ? 'on' : ''}" data-id="${k.id}">
          <label class="marca"><input type="checkbox" data-sel="${k.id}" ${k.sel ? 'checked' : ''} aria-label="Incluir ${esc(k.titulo)}"></label>
          <button type="button" class="clipbtn" data-clip="${k.id}">${k.mini ? `<img src="${k.mini}" alt="">` : '<span class="th"></span>'}<span class="txt"><b>${i + 1}. ${esc(k.titulo)}</b><span class="muted num">${fmt(k.inicio)} → ${fmt(k.fin)} · ${seg(k.fin - k.inicio)}</span><span class="motivo">${esc(k.motivo)}</span></span><span class="nota num" title="Potencial">${k.puntuacion}</span></button>${k.id === R.activo ? ajustes() : ''}</div>`).join('')}</div>
      <div class="card"><h2>Acabado</h2>
        <label class="sw"><input type="checkbox" id="gancho" ${S.gancho ? 'checked' : ''}>Texto en pantalla al empezar</label>
        <label class="sw"><input type="checkbox" id="subt" ${S.subt && S.palabras.length ? 'checked' : ''} ${S.palabras.length ? '' : 'disabled'}>Subtítulos${S.palabras.length ? '' : ' <span class="muted">· necesitan la transcripción</span>'}</label>
        <div class="row"><div class="grow"><b>Formato</b></div>${segBtns(FORMATOS, 'fmt', S.formato, 'Formato')}</div>
        <div class="row"><div class="grow"><b>Encuadre</b></div><div class="seg" role="group" aria-label="Encuadre"><button type="button" data-enc="llenar" aria-pressed="${S.encuadre !== 'ajustar'}">Llenar</button><button type="button" data-enc="ajustar" aria-pressed="${S.encuadre === 'ajustar'}">Ver entera</button></div></div>
      </div>
      <div class="card"><h2>Crear los clips</h2>
        ${x ? `<progress id="prog" value="0" max="1"></progress><div class="row"><span class="num grow">Clip ${x.i} de ${x.n}</span><button type="button" class="btn sm" data-act="cancela">Cancelar</button></div><div class="note">Deja esta pantalla abierta y a la vista. Cada clip tarda lo que dura.</div>`
        : `<p class="muted">${n ? `${n} clip${n > 1 ? 's' : ''} elegido${n > 1 ? 's' : ''} · ${seg(S.clips.filter(k => k.sel).reduce((a, k) => a + k.fin - k.inicio, 0))} en total.` : 'Marca al menos un clip.'}</p>${puedeExportar() ? '' : '<div class="note warn">Este navegador no puede crear el video. Abre el estudio en Chrome o Safari actualizados.</div>'}
          <div class="row"><button type="button" class="btn pri" data-act="crear" ${!n || !m || !puedeExportar() ? 'disabled' : ''}>Crear ${n > 1 ? `los ${n} clips` : 'el clip'}</button>${n > 1 ? `<button type="button" class="btn" data-act="unir" ${!m || !puedeExportar() ? 'disabled' : ''}>Unirlos en un solo video</button>` : ''}</div>`}
        ${R.res.length ? `<div class="lst">${R.res.map((r, i) => `<div class="li"><div class="grow"><b>${esc(r.titulo)}</b><div class="muted num">${esc(r.nombre)} · ${r.mb.toFixed(1).replace('.', ',')} MB</div></div><button type="button" class="btn sm" data-guarda="${i}">Guardar</button></div>`).join('')}</div>
          ${R.res.length > 1 ? '<div><button type="button" class="btn" data-act="zip">Descargar todos en un .zip</button></div>' : ''}${R.res[0].compat ? '' : `<div class="note warn">${AVISO_FORMATO}</div>`}` : ''}
      </div>
      <div class="row"><button type="button" class="btn sm" data-act="rebuscar">Buscar otros momentos</button><button type="button" class="btn sm" data-act="otro">Cambiar de video</button></div>
    </div></div>`;
  $('#lienzo').append(motor.cv); if (!x) motor.mostrar(clamp(motor.t, 0, c ? Math.max(0, c.fin - c.inicio - 0.05) : 0));
}

/* ---------- events ---------- */
function alClick(ev) {
  const t = ev.target.closest('button,[role=button]'); if (!t || !S || !V.contains(t)) return; const d = t.dataset, c = S.clips.find(k => k.id === R.activo);
  if (t.id === 'drop') return $('#fLargo').click();
  if (d.cuantos) { S.cuantos = +d.cuantos; guardar(); return pintar(); }
  if (d.largo) { const l = LARGOS.find(x => x[0] === +d.largo); S.min = l[0]; S.max = l[1]; guardar(); return pintar(); }
  if (d.fmt) { motor.detener(); S.formato = d.fmt; guardar(); return pintar(); }
  if (d.enc) { motor.detener(); S.encuadre = d.enc; guardar(); return pintar(); }
  if (d.clip) { const mismo = R.activo === d.clip; R.activo = d.clip; motor.t = 0; if (!mismo) pintar(); if (R.m) motor.reproducir(0); return; }
  if (d.mueve && c) { motor.detener(); const dur = S.video.dur; if (d.mueve === 'inicio') c.inicio = +clamp(c.inicio + +d.d, 0, c.fin - 1).toFixed(2); else c.fin = +clamp(c.fin + +d.d, c.inicio + 1, dur).toFixed(2); motor.t = d.mueve === 'inicio' ? 0 : Math.max(0, c.fin - c.inicio - 1.5); guardar(); pintar(); if (R.m && d.mueve === 'fin') motor.reproducir(motor.t); return; }
  if (d.guarda) { const r = R.res[+d.guarda]; return r && guardarArchivo(r.blob, r.nombre); }
  switch (d.act) {
    case 'buscar': buscar(); break;
    case 'rebuscar': motor.detener(); S.analizado = false; R.res = []; pintar(); break;
    case 'otro': $('#fLargo').click(); break;
    case 'play': if (motor.sonando) { motor.detener(); motor.mostrar(motor.t); } else motor.reproducir(motor.t); break;
    case 'crear': crear(false); break; case 'unir': crear(true); break; case 'cancela': motor.cancelar(); break;
    case 'copia': copiar($('#descClip').textContent); break;
    case 'zip': zip(R.res.map(r => ({ nombre: r.nombre, blob: r.blob }))).then(b => descargar(b, `${slug(S.video.nombre.replace(/\.[a-z0-9]+$/i, ''))}-clips.zip`)); break;
  }
}
function alInput(ev) {
  const t = ev.target, d = t.dataset; if (!S || !V.contains(t)) return; const c = S.clips.find(k => k.id === R.activo);
  if (t.id === 'contexto') { S.contexto = t.value; return guardar(); }
  if (t.id === 'barra') { if (motor.sonando) motor.detener(); return motor.mostrar(+t.value); }
  if (t.id === 'gancho') { S.gancho = t.checked; guardar(); return motor.sonando || motor.mostrar(motor.t); }
  if (t.id === 'subt') { S.subt = t.checked; guardar(); return motor.sonando || motor.mostrar(motor.t); }
  if (d.c && c) { c[d.c] = d.c === 'foco' ? +t.value : t.value; guardar(); if (d.c === 'titulo') { const b = $(`.clip[data-id="${c.id}"] .txt b`); if (b) b.textContent = `${S.clips.indexOf(c) + 1}. ${c.titulo}`; } if (!motor.sonando) motor.mostrar(d.c === 'gancho' ? Math.min(1, motor.t || 1) : motor.t); }
}
function alChange(ev) {
  const t = ev.target; if (!S) return;
  if (t.id === 'fLargo' && t.files[0]) { const f = t.files[0]; t.value = ''; ponerVideo(f); }
  else if (t.dataset.sel) { const k = S.clips.find(x => x.id === t.dataset.sel); if (k) { k.sel = t.checked; guardar(); pintar(); } }
}

export async function montar({ id }) {
  V = $('#vista'); PID = id; S = null;
  V.innerHTML = '<div class="note" role="status"><span class="spin"></span>Abriendo…</div>';
  const { proyecto } = await api('/projects/' + id);
  S = Object.assign(estadoNuevo(), proyecto.estado || {});
  // the saved state is plain data: keep ids, numbers and thumbnails in the shape the screen expects
  S.clips = (Array.isArray(S.clips) ? S.clips : []).filter(c => c && typeof c === 'object').map(c => ({ ...c, id: String(c.id || uid()).replace(/[^\w-]/g, '') || uid(), inicio: Math.max(0, +c.inicio || 0), fin: Math.max(0, +c.fin || 0), puntuacion: clamp(Math.round(+c.puntuacion || 0), 0, 100), foco: clamp(+c.foco || 0.5, 0, 1), mini: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(c.mini || '') ? c.mini : '', sel: c.sel !== false }));
  S.palabras = (Array.isArray(S.palabras) ? S.palabras : []).filter(w => w && isFinite(w.a) && isFinite(w.b)).map(w => ({ t: String(w.t ?? ''), a: +w.a, b: +w.b }));
  S.cuantos = [3, 6, 9, 12].includes(+S.cuantos) ? +S.cuantos : 6; const largo = LARGOS.find(l => l[0] === +S.min) || LARGOS[0]; S.min = largo[0]; S.max = largo[1]; if (!TAMANOS[S.formato]) S.formato = '9x16';
  if (S.video && !(+S.video.dur > 0)) S.video = null; if (S.video) S.video = { nombre: String(S.video.nombre || 'video'), dur: +S.video.dur, w: +S.video.w || 0, h: +S.video.h || 0, size: +S.video.size || 0 };
  R = { m: null, err: '', nota: '', ocupado: '', buscando: false, fase: '', detalle: '', fasesActivas: [], silencios: [], activo: S.clips[0] ? S.clips[0].id : '', res: [], exp: null, cola: null };
  document.body.dataset.modo = 'clips'; motor.t = 0;
  motor.usar(composicion, { alTiempo: uiTiempo, alReproducir: on => { const b = $('#play'); if (b) b.textContent = on ? '❚❚ Pausa' : '▶ Ver'; } });
  ac = new AbortController(); const o = { signal: ac.signal };
  document.addEventListener('click', alClick, o); document.addEventListener('input', alInput, o); document.addEventListener('change', alChange, o);
  document.addEventListener('keydown', ev => { if (ev.target.id === 'drop' && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); $('#fLargo').click(); } }, o);
  ['dragover', 'dragleave', 'drop'].forEach(n => document.addEventListener(n, ev => { const z = ev.target.closest && ev.target.closest('#drop'); if (!z) return; ev.preventDefault(); z.classList.toggle('over', n === 'dragover'); if (n === 'drop' && ev.dataTransfer.files[0]) ponerVideo(ev.dataTransfer.files[0]); }, o));
  window.addEventListener('pagehide', () => guardarYa(true), o);
  pintar();
  try { await Promise.all([document.fonts.load('600 80px "Cormorant Garamond"'), document.fonts.load('600 40px "DM Sans"')]); } catch {}
  const v = await idb.get(clave('video'));
  if (v && v.blob && PID === id && S) await ponerVideo(new File([v.blob], v.name, { type: v.blob.type }), false);
}
export function desmontar() {
  if (ac) ac.abort(); guardarYa(); motor.cancelar(); motor.vaciar();
  if (R) { if (R.m) URL.revokeObjectURL(R.m.url); R.res.forEach(r => URL.revokeObjectURL(r.url)); }
  S = null; R = null; PID = ''; delete document.body.dataset.modo;
}
