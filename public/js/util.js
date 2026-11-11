// Small helpers shared by every screen.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = t => { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
export const seg = t => (+t).toFixed(1).replace('.', ',') + ' s';
export const uid = () => Math.random().toString(36).slice(2, 9);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const palabras = s => (String(s).trim().match(/\S+/g) || []).length;
export const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';
export const espera = ms => new Promise(r => setTimeout(r, ms));
export const fecha = t => new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short' });

// Phones crash on files that a laptop handles; several limits depend on this.
export const esMovil = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));

let tAviso = 0;
export function avisar(texto, tipo = '') {
  let el = $('#aviso');
  if (!el) { el = document.createElement('div'); el.id = 'aviso'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = texto; el.className = 'aviso on ' + tipo;
  clearTimeout(tAviso); tAviso = setTimeout(() => { el.className = 'aviso ' + tipo; }, 3200);
}

export async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); avisar('Copiado'); }
  catch { avisar('No se pudo copiar. Selecciona el texto y cópialo a mano.', 'warn'); }
}

export function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = nombre; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
// On a phone the share sheet is the way into the camera roll and straight into Instagram or TikTok.
export async function guardarArchivo(blob, nombre) {
  if (esMovil && navigator.canShare) {
    const f = new File([blob], nombre, { type: blob.type });
    if (navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f] }); return 'compartido'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelado'; }
    }
  }
  descargar(blob, nombre);
  return 'descargado';
}

// Store-only ZIP writer (videos do not compress): enough to hand over several clips as one download.
const TABLA = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = TABLA[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export async function zip(archivos) {
  const enc = new TextEncoder(), partes = [], central = []; let pos = 0;
  for (const { nombre, blob } of archivos) {
    const datos = new Uint8Array(await blob.arrayBuffer()), nom = enc.encode(nombre), crc = crc32(datos);
    const cab = new DataView(new ArrayBuffer(30));
    cab.setUint32(0, 0x04034b50, true); cab.setUint16(4, 20, true); cab.setUint16(6, 0x0800, true); cab.setUint16(8, 0, true);
    cab.setUint32(14, crc, true); cab.setUint32(18, datos.length, true); cab.setUint32(22, datos.length, true); cab.setUint16(26, nom.length, true);
    partes.push(cab.buffer, nom, datos);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, datos.length, true); c.setUint32(24, datos.length, true); c.setUint16(28, nom.length, true); c.setUint32(42, pos, true);
    central.push(c.buffer, nom);
    pos += 30 + nom.length + datos.length;
  }
  const tam = central.reduce((a, b) => a + b.byteLength, 0), fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, archivos.length, true); fin.setUint16(10, archivos.length, true); fin.setUint32(12, tam, true); fin.setUint32(16, pos, true);
  return new Blob([...partes, ...central, fin.buffer], { type: 'application/zip' });
}
