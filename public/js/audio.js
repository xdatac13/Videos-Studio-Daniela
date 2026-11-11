// Audio: decoding, the "remove the silences without sounding robotic" analysis, and the
// measurements the highlight finder needs (where the silences are, how loud each moment is).
import { clamp } from './util.js';

export const A = { ctx: null, master: null, oir: null };
export function actx() {
  if (!A.ctx) { A.ctx = new (window.AudioContext || window.webkitAudioContext)(); A.master = A.ctx.createGain(); A.master.connect(A.ctx.destination); }
  if (A.ctx.state === 'suspended') A.ctx.resume();
  return A.ctx;
}

// Decodes any audio or video file the browser can read. A low `rate` keeps a long video's sound small in memory.
export async function decodificar(blob, rate = 48000) {
  const ab = await blob.arrayBuffer(), OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let oc; try { oc = new OC(2, 1, rate); } catch { oc = new OC(2, 1, 44100); }
  return await new Promise((res, rej) => { const p = oc.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
}

// Loudness in dB for every 10 ms frame, plus the speech threshold for this recording.
function niveles(buf) {
  const sr = buf.sampleRate, N = buf.length, c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const hop = Math.round(sr * 0.01), nf = Math.floor(N / hop), db = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let s = 0; const o = f * hop; for (let i = 0; i < hop; i++) { const x = c1 ? (c0[o + i] + c1[o + i]) / 2 : c0[o + i]; s += x * x; } db[f] = 10 * Math.log10(s / hop + 1e-10); }
  const so = Float32Array.from(db).sort(), q = p => so[Math.min(nf - 1, Math.floor(p * nf))];
  const piso = q(0.1), pico = q(0.95);
  return { db, nf, hop, piso, pico, plano: nf < 50 || pico - piso < 8, thr: Math.max(piso + 10, pico - 32) };
}

/* ---------- voice-over: shorten long silences, keep the breathing ---------- */
const MAXP = [0.6, 0.4, 0.25]; // longest pause left untouched, per rhythm: natural, balanced, dynamic
export function analizar(buf, nivel) {
  const sr = buf.sampleRate, N = buf.length, todo = [[0, N]], { db, nf, hop, plano, thr } = niveles(buf);
  if (plano) return { keeps: todo, pausas: [], n: 0 };
  const sp = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) sp[f] = db[f] > thr ? 1 : 0;
  // regions of speech, bridging gaps under 150 ms and dropping clicks under 50 ms
  let reg = [], f = 0; while (f < nf) { if (sp[f]) { let g = f; while (g < nf && sp[g]) g++; reg.push([f, g]); f = g; } else f++; }
  reg = reg.filter(r => r[1] - r[0] >= 5);
  const un = []; for (const r of reg) { const l = un[un.length - 1]; if (l && r[0] - l[1] < 15) l[1] = r[1]; else un.push([r[0], r[1]]); }
  if (!un.length) return { keeps: todo, pausas: [], n: 0 };
  // pad each region so consonants and word tails survive
  const pad = un.map(r => [Math.max(0, (r[0] - 7) * hop), Math.min(N, (r[1] + 13) * hop)]);
  const maxP = MAXP[nivel] * sr, keeps = [[Math.max(0, pad[0][0] - Math.round(0.12 * sr)), pad[0][1]]], marks = []; let n = 0;
  for (let i = 1; i < pad.length; i++) {
    const last = keeps[keeps.length - 1], L = pad[i][0] - last[1];
    if (L <= maxP) { if (L > 0.2 * sr) marks.push({ k: keeps.length - 1, at: last[1] + L / 2, len: L / sr }); last[1] = pad[i][1]; continue; }
    // long pause: keep a breath whose length still depends on the original, so the rhythm is not flattened
    const keep = Math.min(maxP + 0.15 * (L - maxP), maxP * 1.5);
    last[1] += Math.round(keep * 0.4); keeps.push([pad[i][0] - Math.round(keep * 0.6), pad[i][1]]); marks.push({ k: keeps.length - 1, join: true, len: keep / sr }); n++;
  }
  const u = keeps[keeps.length - 1]; u[1] = Math.min(N, u[1] + Math.round(0.25 * sr));
  // pause positions on the cleaned timeline
  const xf = Math.round(0.012 * sr), ini = []; let acc = 0; keeps.forEach((k, i) => { ini.push(acc); acc += k[1] - k[0] - (i < keeps.length - 1 ? xf : 0); });
  const pausas = marks.map(m => ({ t: (m.join ? ini[m.k] : ini[m.k] + (m.at - keeps[m.k][0])) / sr, len: m.len })).filter(p => p.t > 0.2);
  return { keeps, pausas, n };
}
// Joins the kept regions with a 12 ms crossfade so no cut clicks.
export function construir(buf, keeps) {
  const sr = buf.sampleRate, xf = Math.round(0.012 * sr); let len = 0; keeps.forEach((k, i) => len += k[1] - k[0] - (i < keeps.length - 1 ? xf : 0));
  const out = new AudioBuffer({ length: Math.max(1, len), numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = out.getChannelData(c); let pos = 0;
    keeps.forEach((k, i) => { const n = k[1] - k[0]; for (let j = 0; j < n; j++) { let g = 1; if (i > 0 && j < xf) g = j / xf; if (i < keeps.length - 1 && j >= n - xf) g *= (n - j) / xf; if (pos + j < d.length) d[pos + j] += s[k[0] + j] * g; } pos += n - (i < keeps.length - 1 ? xf : 0); });
  }
  return out;
}

/* ---------- long video: silences to cut on, and a loudness profile for Claude ---------- */
export function medir(buf) {
  const { db, nf, plano, thr, piso, pico } = niveles(buf), silencios = [];
  if (!plano) { let f = 0; while (f < nf) { if (db[f] <= thr) { let g = f; while (g < nf && db[g] <= thr) g++; if (g - f >= 25) silencios.push({ a: f / 100, b: g / 100 }); f = g; } else f++; } }
  // one digit per 2 seconds: 0 silence … 9 loudest
  let perfil = '';
  for (let o = 0; o < nf; o += 200) { let s = 0, n = 0; for (let i = o; i < Math.min(nf, o + 200); i++) { s += db[i]; n++; } perfil += plano ? '5' : String(clamp(Math.round(((s / n) - piso) / Math.max(1, pico - piso) * 9), 0, 9)); }
  return { silencios, perfil, plano };
}

// Mono 16-bit WAV at the buffer's own rate, for speech-to-text.
export function wav16(buf) {
  const N = buf.length, sr = buf.sampleRate, c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const ab = new ArrayBuffer(44 + N * 2), v = new DataView(ab), txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); v.setUint32(4, 36 + N * 2, true); txt(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); txt(36, 'data'); v.setUint32(40, N * 2, true);
  for (let i = 0; i < N; i++) { const x = clamp(c1 ? (c0[i] + c1[i]) / 2 : c0[i], -1, 1); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return ab;
}

/* ---------- listening to a buffer ---------- */
export function pararOir() { if (A.oir) { try { A.oir.onended = null; A.oir.stop(); } catch {} A.oir = null; } }
export function oir(buf, clave, a, b) {
  const era = A.oir && A.oir._k === clave; pararOir(); if (era) return;
  const c = actx(), s = c.createBufferSource(); s.buffer = buf; s.connect(A.master);
  s.start(0, a || 0, Math.max(0.05, (b ?? buf.duration) - (a || 0))); s._k = clave; s.onended = () => { if (A.oir === s) A.oir = null; }; A.oir = s;
}
