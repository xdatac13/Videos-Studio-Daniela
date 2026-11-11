// "Edita con Claude": the creator says what she wants in her own words, Claude answers and changes
// the project. The studio hands over a bridge: { estado, contexto, aplicar, deshacer, puedeDeshacer, guardar }.
import { $, esc } from './util.js';
import { ia, mensajeDe } from './api.js';

const IDEAS = ['¿Qué mejorarías de este video?', 'Haz el gancho más corto y directo', 'Quita la escena más floja', 'Hazlo más dinámico'];
let P = null, ocupado = false, listo = false;

function armar() {
  if (listo) return; listo = true;
  const el = $('#chat');
  el.innerHTML = `<div class="chat-cab"><div><b>✦ Edita con Claude</b><small>Dile qué quieres cambiar, con tus palabras.</small></div><button type="button" class="btn ico sm" data-c="cerrar" aria-label="Cerrar">✕</button></div>
    <div class="chat-msgs" id="chatMsgs" aria-live="polite"></div>
    <form id="chatForm"><textarea id="chatTxt" rows="2" placeholder="Ej.: cambia el título por «Mi bolso favorito»" aria-label="Mensaje para Claude"></textarea><button type="submit" class="btn pri" id="chatEnviar">Enviar</button></form>`;
  el.addEventListener('click', ev => {
    const t = ev.target.closest('button'); if (!t || !P) return;
    if (t.dataset.c === 'cerrar') return cerrar();
    if (t.dataset.idea) return enviar(t.dataset.idea);
    if (t.dataset.c === 'deshacer') { const S = P.estado(), m = S.chat[+t.dataset.i]; if (m && P.deshacer()) { m.deshecho = true; P.guardar(); pintar(); } }
  });
  $('#chatForm').addEventListener('submit', ev => { ev.preventDefault(); const tx = $('#chatTxt'), v = tx.value.trim(); if (v && !ocupado) { tx.value = ''; enviar(v); } });
  $('#chatTxt').addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('#chatForm').requestSubmit(); } });
  $('#chatFab').addEventListener('click', () => ($('#chat').hidden ? abrir() : cerrar()));
}

function pintar() {
  if (!P) return; const S = P.estado(), caja = $('#chatMsgs'); if (!S || !caja) return;
  const ult = S.chat.length - 1;
  caja.innerHTML = (S.chat.length ? '' : `<div class="chat-vacio"><p>Puedo cambiar frases, rótulos, el orden de las escenas, qué toma va en cada una, la duración, el sonido, los subtítulos o el formato. También te doy mi opinión.</p><div class="chat-ideas">${IDEAS.map(i => `<button type="button" data-idea="${esc(i)}">${esc(i)}</button>`).join('')}</div></div>`)
    + S.chat.map((m, i) => `<div class="msg ${m.de === 'yo' ? 'yo' : 'claude'}${m.error ? ' error' : ''}"><p>${esc(m.texto)}</p>${m.n ? `<div class="msg-pie"><span>${m.deshecho ? 'Cambios deshechos' : `✓ ${m.n} cambio${m.n > 1 ? 's' : ''} aplicado${m.n > 1 ? 's' : ''}`}</span>${i === ult && !m.deshecho && P.puedeDeshacer() ? `<button type="button" class="btn sm" data-c="deshacer" data-i="${i}">Deshacer</button>` : ''}</div>` : ''}</div>`).join('')
    + (ocupado ? '<div class="msg claude"><p><span class="spin"></span>Claude está pensando…</p></div>' : '');
  caja.scrollTop = caja.scrollHeight;
  $('#chatEnviar').disabled = ocupado;
}

async function enviar(texto) {
  const p0 = P, S = P.estado(); S.chat.push({ de: 'yo', texto }); ocupado = true; pintar();
  try {
    const ctx = P.contexto();
    const d = await ia.pedir('editar', { proyecto: ctx.proyecto, mensaje: texto, historial: S.chat.slice(-11, -1).map(m => ({ de: m.de, texto: m.texto })), hoja: ctx.hoja || undefined });
    if (P !== p0) { ocupado = false; return; }
    const n = d.ops && d.ops.length ? P.aplicar(d.ops, ctx.porT) : 0;
    S.chat.push({ de: 'claude', texto: d.mensaje, n });
  } catch (e) { if (P === p0) S.chat.push({ de: 'claude', texto: mensajeDe(e), error: true }); }
  ocupado = false; if (P !== p0) return;
  if (S.chat.length > 30) S.chat.splice(0, S.chat.length - 30);
  P.guardar(); pintar();
}

export function conectar(puente) { armar(); P = puente; ocupado = false; refrescar(); }
export function desconectar() { P = null; cerrar(); $('#chatFab').hidden = true; }
export function abrir() { if (!P) return; $('#chat').hidden = false; document.body.classList.add('con-chat'); pintar(); if (window.innerWidth > 760) $('#chatTxt').focus(); }
export function cerrar() { const el = $('#chat'); if (el) el.hidden = true; document.body.classList.remove('con-chat'); }
// Called after every studio repaint: the button only makes sense once there is something to edit.
export function refrescar() {
  if (!P) return; const S = P.estado();
  $('#chatFab').hidden = !(ia.activa && S && S.escenas.length && S.paso >= 1);
  if ($('#chatFab').hidden) cerrar(); else if (!$('#chat').hidden) pintar();
}
