// Talks to the studio's server. Every failure becomes { code, message } with a message ready to show.
export const sesion = { user: null, saldo: null, cfg: null, alCambiar: () => {} };

export async function api(ruta, { method = 'GET', body, raw, tipo, keepalive } = {}) {
  let r;
  try {
    r = await fetch('/api' + ruta, {
      method, keepalive, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'estudio', ...(raw ? { 'Content-Type': tipo } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch { throw { code: 'offline', message: 'No hay conexión con el estudio. Revisa tu internet y vuelve a intentarlo.' }; }
  let j = null;
  try { j = await r.json(); } catch {}
  if (r.status === 401 && sesion.user) { sesion.user = null; sesion.alCambiar(); }
  if (!r.ok || (j && j.ok === false)) throw { status: r.status, ...(j && j.error ? j.error : { code: 'server', message: 'Algo falló. Vuelve a intentarlo.' }) };
  if (j && j.saldo) { sesion.saldo = j.saldo; sesion.alCambiar('saldo'); }
  return j;
}

// Claude actions. `ia.activa` says whether the server has a key; screens use it to hide or explain.
export const ia = {
  get activa() { return !!(sesion.cfg && sesion.cfg.ia); },
  get transcribe() { return !!(sesion.cfg && sesion.cfg.transcripcion); },
  coste: k => (sesion.cfg && sesion.cfg.costes && sesion.cfg.costes[k]) || 1,
  pedir: (accion, body) => api('/ai/' + accion, { method: 'POST', body }),
  transcribir: (wav, idioma) => api('/ai/transcribir' + (idioma ? '?idioma=' + idioma : ''), { method: 'POST', raw: wav, tipo: 'audio/wav' }),
};
export const mensajeDe = e => (e && e.message) || 'Algo falló. Vuelve a intentarlo.';
