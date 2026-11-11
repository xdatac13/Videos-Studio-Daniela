// The video engine: draws a composition on a canvas, plays it in sync with the audio, and records
// it to a file. A composition is a plain object built by each screen:
//   { W, H, total, encuadre, subt, voz, musica, musVol,
//     items: [{ key, nombre, ini, dur, m, inicio, sonido, foco, rot, rotTxt, rotDur, ojo, alt,
//               subs: [{ a, b, tx }], vozA, vozDur, falta }] }
// Times are seconds. `m` is a take from media.js (or null: the scene shows a placeholder).
import { A, actx, pararOir } from './audio.js';
import { clamp } from './util.js';

// Preferred first: H.264 + AAC in MP4 is what Instagram, TikTok and every phone accept.
const TIPOS = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4D4028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
// A bare "video/mp4" means H.264 in Safari but VP9 in Chromium, which social apps may refuse.
const compatible = mime => /avc1/.test(mime) || (mime === 'video/mp4' && !/Chrom(e|ium)\//.test(navigator.userAgent));
export const AVISO_FORMATO = 'Este navegador crea el video en un formato que Instagram y TikTok pueden rechazar. Para obtener un MP4 estándar, usa Chrome o Safari actualizados.';
export const TAMANOS = { '9x16': [1080, 1920], '4x5': [1080, 1350], '1x1': [1080, 1080], '16x9': [1920, 1080] };
export const puedeExportar = () => !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && TIPOS.some(t => MediaRecorder.isTypeSupported(t)));

const ease = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
function rr(c, x, y, w, h, rt, rb) { c.beginPath(); c.moveTo(x + rt, y); c.lineTo(x + w - rt, y); c.arcTo(x + w, y, x + w, y + rt, rt); c.lineTo(x + w, y + h - rb); c.arcTo(x + w, y + h, x + w - rb, y + h, rb); c.lineTo(x + rb, y + h); c.arcTo(x, y + h, x, y + h - rb, rb); c.lineTo(x, y + rt); c.arcTo(x, y, x + rt, y, rt); c.closePath(); }
function partir(c, t, maxW) { const ws = String(t).trim().split(/\s+/), ls = []; let l = ''; for (const w of ws) { const p = l ? l + ' ' + w : w; if (l && c.measureText(p).width > maxW) { ls.push(l); l = w; } else l = p; } if (l) ls.push(l); return ls; }

export function crearMotor() {
  const CV = document.createElement('canvas'), X = CV.getContext('2d'); CV.width = 1080; CV.height = 1920;
  const tiny = document.createElement('canvas'), TX = tiny.getContext('2d');
  const RT = new Map(); // item key -> { m, kind, el, src, g, pre }
  const P = { on: false, t: 0, from: 0, t0: 0, raf: 0, srcs: [], idx: -1, C: null, fin: null };
  let dameComp = () => null, ui = {}, exp = null;

  const comp = () => dameComp() || { W: 1080, H: 1920, total: 0, items: [] };
  function medir(C) { if (CV.width !== C.W || CV.height !== C.H) { CV.width = C.W; CV.height = C.H; } }

  /* ----- one <video> per scene, created on demand ----- */
  function rtDe(it) {
    const m = it.m; let r = RT.get(it.key);
    if (!m || m.err) { if (r) { if (r.kind === 'video') r.el.pause(); RT.delete(it.key); } return null; }
    if (!r || r.m !== m.id) {
      if (r && r.kind === 'video') { r.el.pause(); if (r.g) r.g.disconnect(); }
      r = { m: m.id, kind: m.kind, dur: m.dur, pre: false };
      if (m.kind === 'video') { const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v.src = m.url; r.el = v; } else r.el = m.img;
      RT.set(it.key, r);
    }
    return r;
  }
  function conectar(r, it) {
    if (r.kind !== 'video') return; const c = actx();
    if (!r.g) { try { r.src = c.createMediaElementSource(r.el); r.g = c.createGain(); r.src.connect(r.g); r.g.connect(A.master); } catch { r.g = null; } }
    if (r.g) r.g.gain.value = it.sonido; else r.el.volume = clamp(it.sonido, 0, 1);
  }
  const clipT = (it, lt, r) => clamp((+it.inicio || 0) + lt, 0, Math.max(0, (r.dur || 1e9) - 0.05));

  /* ----- drawing ----- */
  function imagen(C, src, w, h, z, foco) {
    const W = CV.width, H = CV.height;
    X.fillStyle = '#3a2230'; X.fillRect(0, 0, W, H);
    if (C.encuadre === 'ajustar' && Math.abs(w / h - W / H) > 0.02) {
      // whole picture visible over a soft blurred copy of itself (a tiny canvas scaled up blurs for free)
      tiny.width = 36; tiny.height = Math.max(8, Math.round(36 * H / W)); const s0 = Math.max(tiny.width / w, tiny.height / h);
      TX.drawImage(src, (tiny.width - w * s0) / 2, (tiny.height - h * s0) / 2, w * s0, h * s0);
      X.imageSmoothingEnabled = true; X.imageSmoothingQuality = 'high'; X.drawImage(tiny, 0, 0, W, H);
      X.fillStyle = 'rgba(58,34,48,.3)'; X.fillRect(0, 0, W, H);
      const s = Math.min(W / w, H / h) * z; X.drawImage(src, (W - w * s) / 2, (H - h * s) / 2, w * s, h * s);
    } else { const s = Math.max(W / w, H / h) * z, dw = w * s, dh = h * s; X.drawImage(src, (W - dw) * (foco ?? 0.5), (H - dh) / 2, dw, dh); }
  }
  function rotulo(C, it, lt) {
    if (!it.rot || it.rot === 'none' || !String(it.rotTxt || '').trim()) return;
    const sale = Math.min(it.dur - 0.3, it.rotDur || 1e9), en = ease((lt - 0.25) / 0.4), al = en * (1 - clamp((lt - sale) / 0.3, 0, 1)); if (al <= 0) return;
    const W = CV.width, H = CV.height, U = Math.min(W, H), c = X, cta = it.rot === 'cta', tit = it.rot === 'titulo';
    const bg = cta ? '#7a2440' : tit ? '#fbf6f4' : (it.alt ? '#d9c8ec' : '#f2c9d4'), fg = cta ? '#fbf6f4' : '#3a2230';
    const fs = Math.round(U * (tit ? 0.085 : 0.07)), ojo = tit && it.ojo ? String(it.ojo).toUpperCase() : '', ofs = Math.round(U * 0.027);
    c.save(); c.globalAlpha = al; c.font = `${cta ? 'italic 500' : '600'} ${fs}px "Cormorant Garamond", Georgia, serif`;
    const ls = partir(c, it.rotTxt, U * 0.66), lh = fs * 1.08, tw = Math.max(...ls.map(l => c.measureText(l).width));
    const px = U * 0.065, pt = U * 0.085, pb = U * 0.055, w = Math.max(tw, U * 0.32) + px * 2, h = pt + (ojo ? ofs * 2 : 0) + ls.length * lh + pb, x = (W - w) / 2, y = H * (W > H ? 0.1 : 0.14) + (1 - en) * 50;
    c.fillStyle = bg; rr(c, x, y, w, h, Math.min(w / 2, U * 0.12), U * 0.025); c.fill();
    c.textAlign = 'center'; c.textBaseline = 'top'; let ty = y + pt;
    if (ojo) { c.font = `600 ${ofs}px "DM Sans", Arial, sans-serif`; c.fillStyle = '#7a2440'; try { c.letterSpacing = '0.12em'; } catch {} c.fillText(ojo, W / 2, ty); try { c.letterSpacing = '0px'; } catch {} ty += ofs * 2; c.font = `600 ${fs}px "Cormorant Garamond", Georgia, serif`; }
    c.fillStyle = fg; ls.forEach((l, k) => c.fillText(l, W / 2, ty + k * lh)); c.restore();
  }
  function subtitulo(C, it, lt) {
    if (!C.subt || !it.subs || !it.subs.length) return;
    const s = it.subs.find(x => lt >= x.a && lt < x.b); if (!s) return;
    const W = CV.width, H = CV.height, U = Math.min(W, H), c = X, fs = Math.round(U * 0.044); c.save(); c.font = `600 ${fs}px "DM Sans", Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = c.measureText(s.tx).width + fs * 1.3, h = fs * 1.9, y = H * (W > H ? 0.84 : 0.74); c.fillStyle = '#7a2440'; rr(c, (W - w) / 2, y - h / 2, w, h, fs * 0.4, fs * 0.4); c.fill(); c.fillStyle = '#fbf6f4'; c.fillText(s.tx, W / 2, y + fs * 0.04); c.restore();
  }
  function vacio(it, txt) {
    const W = CV.width, H = CV.height, U = Math.min(W, H), c = X; c.fillStyle = '#f4e6ea'; c.fillRect(0, 0, W, H); c.fillStyle = '#f2c9d4'; rr(c, W / 2 - U * 0.2, H * 0.34, U * 0.4, H * 0.7, U * 0.2, 0); c.fill();
    c.fillStyle = '#7a2440'; c.textAlign = 'center'; c.textBaseline = 'top'; c.font = `600 ${U * 0.06}px "Cormorant Garamond", Georgia, serif`; c.fillText(it ? it.nombre || '' : '', W / 2, H * 0.22);
    c.fillStyle = '#6e5562'; c.font = `500 ${U * 0.032}px "DM Sans", Arial, sans-serif`; partir(c, txt, U * 0.7).forEach((l, k) => c.fillText(l, W / 2, H * 0.22 + U * 0.09 + k * U * 0.045));
  }
  function pintar(t, play) {
    const C = play ? P.C : comp(); medir(C);
    let i = C.items.findIndex(it => t < it.ini + it.dur); if (i < 0) i = C.items.length - 1; const it = C.items[i];
    if (!it) { vacio(null, 'Tu video aparecerá aquí'); return; }
    const lt = t - it.ini, r = rtDe(it);
    if (play && i !== P.idx) {
      if (P.idx >= 0) { const p = RT.get(C.items[P.idx].key); if (p && p.kind === 'video' && p !== r) p.el.pause(); } P.idx = i;
      if (r && r.kind === 'video') { conectar(r, it); const w = clipT(it, lt, r); if (Math.abs(r.el.currentTime - w) > 0.15) r.el.currentTime = w; r.pre = false; r.el.play().catch(() => {}); }
      if (ui.alCambiarEscena) ui.alCambiarEscena(i);
    }
    // get the next scene's video ready a moment before the cut
    if (play && lt > it.dur - 0.7) { const nx = C.items[i + 1], nr = nx && rtDe(nx); if (nr && nr !== r && nr.kind === 'video' && nr.el.paused && !nr.pre) { nr.pre = true; nr.el.currentTime = +nx.inicio || 0; } }
    if (r) {
      if (r.kind === 'video') { if (r.el.readyState < 2) { if (play) return; vacio(it, 'Cargando la toma…'); } else imagen(C, r.el, r.el.videoWidth, r.el.videoHeight, 1, it.foco); }
      else imagen(C, r.el, r.el.naturalWidth, r.el.naturalHeight, 1 + 0.08 * lt / it.dur, it.foco);
    } else vacio(it, it.falta || 'Falta la toma');
    rotulo(C, it, lt); subtitulo(C, it, lt);
  }
  // Shows the frame at t while paused; repaints when the video has actually reached that frame.
  function mostrar(t) {
    P.t = t; const C = comp(), it = C.items.find(x => t < x.ini + x.dur);
    if (it) {
      const r = rtDe(it);
      if (r && r.kind === 'video') {
        const w = clipT(it, t - it.ini, r);
        r.el.addEventListener('seeked', () => { if (!P.on) pintar(P.t, false); }, { once: true });
        if (r.el.readyState < 2) r.el.addEventListener('loadeddata', () => { if (!P.on) pintar(P.t, false); }, { once: true });
        r.el.currentTime = w;
      }
    }
    pintar(t, false); if (ui.alTiempo) ui.alTiempo(t, C.total);
  }
  function detener() {
    P.on = false; cancelAnimationFrame(P.raf); P.srcs.forEach(s => { try { s.stop(); } catch {} }); P.srcs = [];
    RT.forEach(r => { if (r.kind === 'video') { r.el.pause(); r.pre = false; } }); P.idx = -1; if (ui.alReproducir) ui.alReproducir(false);
  }
  function reproducir(from, alFin) {
    detener(); pararOir(); const c = actx(), C = comp(); if (C.total <= 0) return; if (from >= C.total - 0.05) from = 0; medir(C);
    Object.assign(P, { C, on: true, from, t0: c.currentTime + 0.12, idx: -1, fin: alFin || null }); const at = x => P.t0 + Math.max(0, x - from);
    // the voice: each scene plays its own stretch of the cleaned recording
    if (C.voz) for (const it of C.items) { if (!(it.vozDur > 0) || it.ini + it.vozDur <= from) continue; const off = Math.max(0, from - it.ini), s = c.createBufferSource(); s.buffer = C.voz; s.connect(A.master); s.start(at(it.ini), it.vozA + off, Math.max(0.01, it.vozDur - off)); P.srcs.push(s); }
    // the music: loops, ducks under the voice, fades out at the end
    if (C.musica) {
      const g = c.createGain(), fd = c.createGain(), s = c.createBufferSource(), base = C.musVol ?? 0.5, bajo = base * 0.28; s.buffer = C.musica; s.loop = true; s.connect(g); g.connect(fd); fd.connect(A.master);
      const iv = []; for (const it of C.items) { if (!(it.vozDur > 0) || !C.voz) continue; const l = iv[iv.length - 1]; if (l && it.ini - l[1] < 0.6) l[1] = it.ini + it.vozDur; else iv.push([it.ini, it.ini + it.vozDur]); }
      g.gain.setValueAtTime(iv.some(v => from >= v[0] - 0.1 && from < v[1]) ? bajo : base, c.currentTime);
      for (const v of iv) { if (v[0] - 0.25 > from) { g.gain.setValueAtTime(base, at(v[0] - 0.25)); g.gain.linearRampToValueAtTime(bajo, at(v[0])); } if (v[1] > from) { g.gain.setValueAtTime(bajo, at(v[1])); g.gain.linearRampToValueAtTime(base, at(v[1] + 0.5)); } }
      fd.gain.setValueAtTime(1, at(Math.max(from, C.total - 1.2))); fd.gain.linearRampToValueAtTime(0.0001, at(C.total)); s.start(P.t0, from % s.buffer.duration); P.srcs.push(s);
    }
    if (ui.alReproducir) ui.alReproducir(true);
    const tick = () => { if (!P.on) return; const t = P.from + Math.max(0, A.ctx.currentTime - P.t0); P.t = t; if (t >= P.C.total) { const f = P.fin; detener(); P.t = 0; if (f) f(); else mostrar(0); return; } pintar(t, true); if (ui.alTiempo) ui.alTiempo(t, P.C.total); P.raf = requestAnimationFrame(tick); };
    P.raf = requestAnimationFrame(tick);
  }

  /* ----- export: plays the composition once and records canvas + audio ----- */
  async function exportar(progreso) {
    if (exp) return null; detener(); const c = actx(), C = comp(); if (C.total <= 0) return null;
    const mime = window.MediaRecorder ? TIPOS.find(t => MediaRecorder.isTypeSupported(t)) : null;
    if (!mime || !CV.captureStream) throw { code: 'no_export', message: 'Este navegador no puede crear el video. Abre el estudio en Chrome o Safari actualizados.' };
    medir(C);
    const st = CV.captureStream(30), dest = c.createMediaStreamDestination(); A.master.connect(dest); dest.stream.getAudioTracks().forEach(t => st.addTrack(t));
    const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192000 }), ch = []; rec.ondataavailable = e => e.data.size && ch.push(e.data);
    let wl = null; try { wl = await navigator.wakeLock.request('screen'); } catch {}
    exp = { cancel: false, stop: null };
    const fin = new Promise(r => rec.onstop = r); rec.start(1000);
    const iv = setInterval(() => progreso && progreso(P.t, C.total), 250);
    await new Promise(r => { reproducir(0, r); exp.stop = () => { exp.cancel = true; detener(); r(); }; });
    await new Promise(r => setTimeout(r, 250)); rec.stop(); await fin; clearInterval(iv);
    try { A.master.disconnect(dest); } catch {} st.getTracks().forEach(t => t.stop()); if (wl) wl.release().catch(() => {});
    const cancel = exp.cancel; exp = null;
    if (cancel) return null;
    return { blob: new Blob(ch, { type: mime.split(';')[0] }), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm', compat: compatible(mime) };
  }

  // The current frame as a JPEG, once the video has really landed on it (for covers).
  async function foto(t) {
    detener(); const C = comp(), it = C.items.find(x => t < x.ini + x.dur) || C.items[C.items.length - 1];
    if (it) { const r = rtDe(it); if (r && r.kind === 'video') { await new Promise(res => { let ok = false; const f = () => { if (!ok) { ok = true; res(); } }; r.el.addEventListener('seeked', f, { once: true }); setTimeout(f, 2500); r.el.currentTime = clipT(it, t - it.ini, r); }); } }
    P.t = t; pintar(t, false);
    return CV;
  }

  return {
    cv: CV, ctx: X,
    usar(fn, cb = {}) { detener(); dameComp = fn; ui = cb; },
    mostrar, reproducir, detener, exportar, foto,
    cancelar() { if (exp && exp.stop) exp.stop(); },
    get t() { return P.t; }, set t(v) { P.t = v; },
    get sonando() { return P.on; }, get exportando() { return !!exp; },
    // Drops every <video> (leaving a project) so decoders and memory are released.
    vaciar() { detener(); RT.forEach(r => { if (r.kind === 'video') { if (r.g) try { r.g.disconnect(); } catch {} r.el.removeAttribute('src'); r.el.load(); } }); RT.clear(); },
    olvidar(key) { const r = RT.get(key); if (r && r.kind === 'video') { r.el.pause(); if (r.g) try { r.g.disconnect(); } catch {} r.el.removeAttribute('src'); r.el.load(); } RT.delete(key); },
  };
}
export const motor = crearMotor();
