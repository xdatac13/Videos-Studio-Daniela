// Takes (videos and photos): loading, thumbnails, and the contact sheets Claude looks at.
// A contact sheet is a grid of frames, each labelled with its time, so one image tells Claude
// what happens across a whole take or a whole long video.
import { uid, fmt } from './util.js';

export function mini(src, w, h) {
  const c = document.createElement('canvas'); c.width = 180; c.height = 320;
  const x = c.getContext('2d'), s = Math.max(180 / w, 320 / h);
  x.drawImage(src, (180 - w * s) / 2, (320 - h * s) / 2, w * s, h * s);
  return c;
}
const jpg = (c, q = 0.75) => { try { return c.toDataURL('image/jpeg', q); } catch { return ''; } };

export function irAT(v, t) {
  return new Promise(r => { let ok = false; const fin = () => { if (!ok) { ok = true; v.onseeked = null; r(); } }; v.onseeked = fin; setTimeout(fin, 4000); v.currentTime = t; });
}
// A muted, off-screen <video> ready to seek; call soltar(v) when done so the decoder is released.
export async function abrirVideo(url) {
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  let err = false;
  await new Promise(r => { v.onloadeddata = r; v.onerror = () => { err = true; r(); }; setTimeout(r, 10000); });
  return err || !v.videoWidth ? null : v;
}
export function soltar(v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }

export async function cargarMedia(file, id) {
  const img = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|heic)$/i.test(file.name || '');
  const m = { id: id || uid(), name: file.name || 'toma', kind: img ? 'image' : 'video', url: URL.createObjectURL(file), dur: 0, w: 0, h: 0, thumb: '', cv: null, err: false, size: file.size || 0, file };
  if (img) {
    m.img = new Image(); m.img.src = m.url;
    try { await m.img.decode(); m.w = m.img.naturalWidth; m.h = m.img.naturalHeight; m.cv = mini(m.img, m.w, m.h); m.thumb = jpg(m.cv, 0.7); } catch { m.err = true; }
  } else {
    const v = await abrirVideo(m.url);
    if (v) {
      m.dur = isFinite(v.duration) ? v.duration : 0; m.w = v.videoWidth; m.h = v.videoHeight;
      await irAT(v, Math.min(0.5, m.dur / 2)); m.cv = mini(v, m.w, m.h); m.thumb = jpg(m.cv, 0.7); soltar(v);
    } else m.err = true;
  }
  return m;
}

/* ---------- sheets by take (video first: Claude cuts from raw takes) ---------- */
// One row per take, a few frames across it, labelled with the take id and the second of each frame.
export async function hojasTomas(lista, maxImg) {
  const rows = Math.ceil(lista.length / maxImg); if (rows > 3) throw { code: 'muchas', max: maxImg * 3 };
  const K = rows === 1 ? 6 : rows === 2 ? 5 : 4, W = 1200, cw = W / K, ch = Math.round(cw * 16 / 9), lab = 34, rh = lab + ch + 24, out = [];
  for (let s = 0; s < lista.length; s += rows) {
    const grupo = lista.slice(s, s + rows), c = document.createElement('canvas'); c.width = W; c.height = rh * grupo.length; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.textBaseline = 'top';
    for (let g = 0; g < grupo.length; g++) {
      const { m, id } = grupo[g], y0 = g * rh;
      x.fillStyle = '#000'; x.font = 'bold 22px Arial'; x.fillText(`${id} · ${m.kind === 'video' ? 'video de ' + m.dur.toFixed(1) + ' s' : 'foto'}`, 8, y0 + 6);
      const dib = (src, w, h, k, t) => { const z = Math.min(cw / w, ch / h), dw = w * z, dh = h * z; x.fillStyle = '#222'; x.fillRect(k * cw + 1, y0 + lab, cw - 2, ch); x.drawImage(src, k * cw + (cw - dw) / 2, y0 + lab + (ch - dh) / 2, dw, dh); if (t != null) { x.fillStyle = '#000'; x.font = '16px Arial'; x.fillText(t.toFixed(1) + ' s', k * cw + 6, y0 + lab + ch + 4); } };
      if (m.kind === 'image') dib(m.img, m.w, m.h, 0, null);
      else { const v = await abrirVideo(m.url); if (v) { for (let k = 0; k < K; k++) { const t = m.dur * (k + 0.5) / K; await irAT(v, t); dib(v, v.videoWidth, v.videoHeight, k, t); } soltar(v); } }
    }
    out.push(jpg(c, 0.8));
  }
  return out;
}

/* ---------- sheets by time (long video: one frame every few seconds) ---------- */
function rejilla(m) {
  const r = m.w / m.h;
  if (r < 0.8) { const tw = 224; return { cols: 7, rows: 3, tw, th: Math.min(398, Math.round(tw / r)) }; }
  if (r > 1.3) { const tw = 384; return { cols: 4, rows: 5, tw, th: Math.round(tw / r) }; }
  return { cols: 5, rows: 4, tw: 300, th: Math.round(300 / r) };
}
// Draws the frames at `tiempos` (seconds) into as many sheets as needed. `titulo` heads each sheet.
export async function hojasTiempo(v, m, tiempos, { titulo = '', decimales = 0, progreso } = {}) {
  const g = rejilla(m), por = g.cols * g.rows, lab = 28, cab = titulo ? 34 : 0, out = [];
  for (let s = 0; s < tiempos.length; s += por) {
    const grupo = tiempos.slice(s, s + por), filas = Math.ceil(grupo.length / g.cols);
    const c = document.createElement('canvas'); c.width = g.cols * g.tw; c.height = cab + filas * (g.th + lab); const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.textBaseline = 'top';
    if (titulo) { x.fillStyle = '#000'; x.font = 'bold 24px Arial'; x.fillText(titulo, 8, 5); }
    for (let k = 0; k < grupo.length; k++) {
      const t = grupo[k], cx = (k % g.cols) * g.tw, cy = cab + Math.floor(k / g.cols) * (g.th + lab);
      await irAT(v, Math.min(t, Math.max(0, m.dur - 0.05)));
      x.drawImage(v, cx + 1, cy, g.tw - 2, g.th);
      x.fillStyle = '#000'; x.font = 'bold 19px Arial'; x.fillText(decimales ? `${t.toFixed(decimales)}s` : `${Math.round(t)}s · ${fmt(t)}`, cx + 6, cy + g.th + 4);
      if (progreso) progreso(s + k + 1, tiempos.length);
    }
    out.push(jpg(c, 0.72));
  }
  return out;
}

// One labelled thumbnail per take, for the chat: lets Claude pick takes by what they show.
export function hojaMiniaturas(items) {
  const lista = items.filter(i => i.m.cv).slice(0, 32); if (!lista.length) return '';
  const cols = Math.min(8, lista.length), tw = 150, th = 267, lab = 28, filas = Math.ceil(lista.length / cols);
  const c = document.createElement('canvas'); c.width = cols * tw; c.height = filas * (th + lab); const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.textBaseline = 'top'; x.font = 'bold 18px Arial';
  lista.forEach(({ m, id }, k) => { const cx = (k % cols) * tw, cy = Math.floor(k / cols) * (th + lab); x.drawImage(m.cv, cx + 1, cy, tw - 2, th); x.fillStyle = '#000'; x.fillText(`${id}${m.kind === 'video' ? ' · ' + m.dur.toFixed(0) + ' s' : ' · foto'}`, cx + 6, cy + th + 5); });
  return jpg(c, 0.72);
}

// A single frame as a small JPEG (clip cards, project covers).
export async function cuadro(v, m, t, w = 180, h = 320) {
  await irAT(v, Math.min(t, Math.max(0, m.dur - 0.05)));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'), s = Math.max(w / m.w, h / m.h);
  x.drawImage(v, (w - m.w * s) / 2, (h - m.h * s) / 2, m.w * s, m.h * s);
  return jpg(c, 0.7);
}
