// App shell: session, routes, and the simple screens (sign in, home, account, admin).
import { $, esc, fecha, avisar } from './util.js';
import { api, sesion, ia, mensajeDe } from './api.js';
import { idb } from './idb.js';
import * as studio from './studio.js';
import * as clips from './clips.js';

const V = $('#vista');
let actual = null, turno = 0;
const ir = h => { if (location.hash === h) navegar(); else location.hash = h; };

/* ---------- header ---------- */
function cabecera() {
  const u = sesion.user, s = sesion.saldo, el = $('#cuentaNav');
  el.innerHTML = !u ? '' : `${location.hash && location.hash !== '#/' ? '<a class="navlink" href="#/">Mis videos</a>' : ''}
    ${ia.activa && s ? `<a class="creditos" href="#/cuenta" title="Créditos de Claude que te quedan este mes"><span>✦</span><b class="num">${s.quedan}</b></a>` : ''}
    <a class="avatar" href="#/cuenta" aria-label="Mi cuenta">${esc((u.nombre || u.email).trim().charAt(0).toUpperCase())}</a>`;
}
sesion.alCambiar = que => { if (que === 'saldo') cabecera(); else navegar(); };

/* ---------- sign in / sign up ---------- */
const entrar = {
  montar({ alta }) {
    const reg = sesion.cfg.registro, puedeAlta = reg !== 'closed';
    if (alta && !puedeAlta) alta = false;
    document.body.dataset.modo = 'entrar';
    V.innerHTML = `<div class="entrar"><div class="entrar-arte" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <form class="card entrar-form" id="fEntrar" novalidate>
        <div class="head"><span class="eyebrow">Estudio Daniela</span><h1>${alta ? 'Crea tu cuenta' : 'Hola de nuevo'}</h1><p class="lead">${alta ? 'Tu editor de video con Claude: del guion al video listo para publicar.' : 'Entra para seguir con tus videos.'}</p></div>
        ${alta ? '<label class="f">Tu nombre<input type="text" name="nombre" autocomplete="given-name" maxlength="60"></label>' : ''}
        <label class="f">Correo<input type="email" name="email" autocomplete="email" required></label>
        <label class="f">Contraseña${alta ? ' <small>Al menos 8 caracteres.</small>' : ''}<input type="password" name="pass" autocomplete="${alta ? 'new-password' : 'current-password'}" required minlength="8"></label>
        ${alta && reg === 'invite' ? '<label class="f">Código de invitación<input type="text" name="codigo" autocomplete="off" required></label>' : ''}
        <div class="note warn" id="eEntrar" role="alert" hidden></div>
        <button type="submit" class="btn pri ancho">${alta ? 'Crear mi cuenta' : 'Entrar'}</button>
        ${puedeAlta ? `<p class="muted centro">${alta ? '¿Ya tienes cuenta? <a href="#/entrar">Entra</a>' : '¿Primera vez? <a href="#/crear-cuenta">Crea tu cuenta</a>'}</p>` : ''}
        ${alta ? '' : '<p class="muted centro">¿Olvidaste la contraseña? Pídele a quien administra el estudio que te ponga una nueva.</p>'}
      </form></div>`;
    $('#fEntrar').addEventListener('submit', async ev => {
      ev.preventDefault(); const f = new FormData(ev.target), b = ev.target.querySelector('button[type=submit]'), e = $('#eEntrar'); b.disabled = true; e.hidden = true;
      try { const r = await api(alta ? '/auth/signup' : '/auth/login', { method: 'POST', body: Object.fromEntries(f) }); sesion.user = r.user; sesion.saldo = r.saldo; ir('#/'); }
      catch (x) { e.textContent = mensajeDe(x); e.hidden = false; b.disabled = false; }
    });
  },
  desmontar() { delete document.body.dataset.modo; },
};

/* ---------- home: start something, or pick up a video ---------- */
const inicio = {
  async montar() {
    const u = sesion.user, c = sesion.cfg; let lista = [];
    const pinta = () => {
      V.innerHTML = `<div class="head"><span class="eyebrow">Hola${u.nombre ? ', ' + esc(u.nombre) : ''}</span><h1>¿Qué creamos hoy?</h1></div>
      ${c.demo ? '<div class="note"><span class="tag">Demostración</span> Claude responde con ejemplos fijos. Con una clave de Claude en el servidor, mira de verdad tus videos.</div>' : !c.ia ? `<div class="note warn">Claude no está activado todavía. ${u.rol === 'admin' ? 'Añade la variable ANTHROPIC_API_KEY en el servidor y reinícialo.' : 'El estudio funciona, pero sin las ayudas de Claude.'}</div>` : ''}
      <div class="tipos">
        <button type="button" class="tipo grande" data-nuevo="video"><b>Crear un video</b><span>Paso a paso: tu idea, el guion, tu voz, tus tomas y el montaje. Para un unboxing o la visita a un lugar.</span><em>Empezar →</em></button>
        <button type="button" class="tipo grande lav" data-nuevo="clips"><b>Sacar extractos</b><span>Sube un video largo y Claude encuentra sus mejores momentos de 5 a 10 segundos, listos para Reels y TikTok.</span><em>Subir un video →</em></button>
      </div>
      <div class="head" style="margin-top:8px"><h2>Mis videos</h2></div>
      ${lista.length ? `<div class="proyectos">${lista.map(p => `<article class="proy" data-id="${p.id}"><a href="#/${p.tipo === 'clips' ? 'extractos' : 'video'}/${p.id}">${p.mini ? `<img src="${p.mini}" alt="">` : '<span class="th"></span>'}<span class="tag">${p.tipo === 'clips' ? 'Extractos' : 'Video'}</span><b>${esc(p.nombre || 'Sin título')}</b><span class="muted">${fecha(p.actualizado)}</span></a><button type="button" class="btn sm" data-borra="${p.id}">Borrar</button></article>`).join('')}</div>` : '<p class="muted">Aquí aparecerán tus videos. Empieza con uno de los dos botones de arriba.</p>'}`;
    };
    pinta();
    V.onclick = async ev => {
      const t = ev.target.closest('button'); if (!t) return;
      if (t.dataset.nuevo) {
        t.disabled = true;
        try { const tipo = t.dataset.nuevo, { proyecto } = await api('/projects', { method: 'POST', body: { tipo, nombre: '', estado: tipo === 'clips' ? clips.estadoNuevo() : studio.estadoNuevo() } }); ir(`#/${tipo === 'clips' ? 'extractos' : 'video'}/${proyecto.id}`); }
        catch (e) { avisar(mensajeDe(e), 'warn'); t.disabled = false; }
      } else if (t.dataset.borra) {
        if (!t.dataset.ok) { t.dataset.ok = '1'; t.textContent = '¿Seguro? Pulsa otra vez'; t.classList.add('rec'); return; }
        try { await api('/projects/' + t.dataset.borra, { method: 'DELETE' }); idb.borrarProyecto(t.dataset.borra); lista = lista.filter(p => p.id !== t.dataset.borra); pinta(); } catch (e) { avisar(mensajeDe(e), 'warn'); }
      }
    };
    try { lista = (await api('/projects')).proyectos; pinta(); } catch (e) { avisar(mensajeDe(e), 'warn'); }
  },
  desmontar() { V.onclick = null; },
};

/* ---------- account ---------- */
const cuenta = {
  async montar() {
    try { const r = await api('/me'); if (r.user) { sesion.user = r.user; sesion.saldo = r.saldo; cabecera(); } } catch {}
    const u = sesion.user, s = sesion.saldo, c = sesion.cfg, p = u.perfil, pagoOk = /pago=ok/.test(location.hash);
    V.innerHTML = `<div class="head"><span class="eyebrow">Mi cuenta</span><h1>${esc(u.nombre || u.email)}</h1></div>
      ${pagoOk ? '<div class="note ok">Gracias. Tu plan Pro se activa en unos segundos.</div>' : ''}
      <div class="card"><h2>Tu plan</h2>
        <div class="row"><div class="stats grow"><div><b>${esc(c.planes[u.plan] ? c.planes[u.plan].nombre : u.plan)}</b><span>plan actual</span></div><div><b class="num">${s.quedan}</b><span>créditos de Claude este mes, de ${s.total}</span></div></div>
        ${c.pagos ? (u.plan === 'free' ? `<button type="button" class="btn pri" data-act="pro">Pasar a Pro · ${c.planes.pro.creditos} créditos al mes</button>` : '<button type="button" class="btn" data-act="portal">Gestionar mi suscripción</button>') : ''}</div>
        <progress value="${s.usados}" max="${Math.max(1, s.total)}"></progress>
        <p class="muted">Un crédito es una petición sencilla a Claude (un guion, un cambio por chat, los textos para publicar). Montar desde tus tomas gasta ${c.costes.montaje}; buscar extractos en un video largo, ${c.costes.extractos + c.costes.afinar}${c.transcripcion ? ` más ${c.costes.transcribir} de transcripción` : ''}. Se renuevan el día 1 de cada mes.</p></div>
      <form class="card" id="fPerfil"><h2>Tu estilo</h2><p class="muted">Claude escribe tus guiones y textos con esta voz.</p>
        <div class="grid2"><label class="f">Tu nombre<input type="text" name="nombre" value="${esc(u.nombre)}" maxlength="60"></label><label class="f">De qué va tu contenido<input type="text" name="nicho" value="${esc(p.nicho)}" maxlength="120"></label></div>
        <label class="f">Tu tono <small>Cómo hablas a tu comunidad.</small><textarea name="tono" rows="2" maxlength="300">${esc(p.tono)}</textarea></label>
        <label class="f">Idioma de tus videos<input type="text" name="idioma" value="${esc(p.idioma)}" maxlength="30"></label>
        <div class="row"><button type="submit" class="btn pri">Guardar</button><span class="muted" id="okPerfil"></span></div></form>
      <form class="card" id="fPass"><h2>Contraseña</h2><div class="grid2"><label class="f">Actual<input type="password" name="actual" autocomplete="current-password" required></label><label class="f">Nueva<input type="password" name="nueva" autocomplete="new-password" required minlength="8"></label></div>
        <div class="row"><button type="submit" class="btn">Cambiar la contraseña</button><span class="muted" id="okPass"></span></div></form>
      <div class="row">${u.rol === 'admin' ? '<a class="btn" href="#/admin">Administrar el estudio</a>' : ''}<button type="button" class="btn" data-act="salir">Cerrar sesión</button><span class="grow"></span><span class="muted">${esc(u.email)}</span></div>`;
    $('#fPerfil').onsubmit = async ev => { ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); try { const r = await api('/me', { method: 'PUT', body: { nombre: f.nombre, perfil: { nicho: f.nicho, tono: f.tono, idioma: f.idioma } } }); sesion.user = r.user; cabecera(); $('#okPerfil').textContent = 'Guardado.'; } catch (e) { $('#okPerfil').textContent = mensajeDe(e); } };
    $('#fPass').onsubmit = async ev => { ev.preventDefault(); try { await api('/me/password', { method: 'PUT', body: Object.fromEntries(new FormData(ev.target)) }); ev.target.reset(); $('#okPass').textContent = 'Contraseña cambiada.'; } catch (e) { $('#okPass').textContent = mensajeDe(e); } };
    V.onclick = async ev => {
      const a = ev.target.closest('button')?.dataset.act; if (!a) return;
      try {
        if (a === 'salir') { await api('/auth/logout', { method: 'POST' }); sesion.user = null; ir('#/entrar'); }
        else if (a === 'pro') location.href = (await api('/billing/checkout', { method: 'POST' })).url;
        else if (a === 'portal') location.href = (await api('/billing/portal', { method: 'POST' })).url;
      } catch (e) { avisar(mensajeDe(e), 'warn'); }
    };
  },
  desmontar() { V.onclick = null; },
};

/* ---------- admin: who uses the studio and how much ---------- */
const admin = {
  async montar() {
    const { usuarios, modelo } = await api('/admin/users'), c = sesion.cfg;
    V.innerHTML = `<div class="head"><span class="eyebrow">Administración</span><h1>Cuentas del estudio</h1><p class="lead">Modelo: ${esc(modelo)} · Registro: ${esc({ open: 'abierto', invite: 'con código de invitación', closed: 'cerrado' }[c.registro])} · Pagos: ${c.pagos ? 'Stripe' : 'desactivados'} · Transcripción: ${c.transcripcion ? 'activada' : 'desactivada'}</p></div>
      <div class="card tabla"><table><thead><tr><th>Cuenta</th><th>Plan</th><th class="num">Videos</th><th class="num">Créditos (mes)</th><th class="num">Tokens (mes)</th></tr></thead><tbody>
      ${usuarios.map(u => `<tr><td><b>${esc(u.nombre || '—')}</b>${u.rol === 'admin' ? ' <span class="tag">admin</span>' : ''}<div class="muted">${esc(u.email)} · desde ${fecha(u.creado)}</div></td>
        <td><select data-plan="${u.id}" aria-label="Plan de ${esc(u.email)}">${Object.entries(c.planes).map(([k, p]) => `<option value="${k}" ${u.plan === k ? 'selected' : ''}>${esc(p.nombre)} · ${p.creditos}</option>`).join('')}</select></td>
        <td class="num">${u.videos}</td><td class="num">${u.creditos}</td><td class="num">${(u.tokens_in / 1000).toFixed(0)}k entrada · ${(u.tokens_out / 1000).toFixed(0)}k salida</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted">Los tokens son el consumo real de Claude de cada cuenta este mes: multiplícalos por la tarifa de tu modelo para saber el coste.</p>`;
    V.onchange = async ev => { const id = ev.target.dataset.plan; if (!id) return; try { await api('/admin/users/' + id, { method: 'PUT', body: { plan: ev.target.value } }); avisar('Plan cambiado'); } catch (e) { avisar(mensajeDe(e), 'warn'); } };
  },
  desmontar() { V.onchange = null; },
};

/* ---------- router ---------- */
async function navegar() {
  const yo = ++turno, h = location.hash || '#/';
  if (actual) { try { actual.desmontar(); } catch (e) { console.error(e); } actual = null; }
  window.scrollTo(0, 0);
  let vista, params = {};
  if (!sesion.user) { vista = entrar; params.alta = h === '#/crear-cuenta'; if (h !== '#/entrar' && h !== '#/crear-cuenta') history.replaceState(null, '', '#/entrar'); }
  else {
    const m = /^#\/(video|extractos)\/([\w-]+)$/.exec(h);
    if (m) { vista = m[1] === 'video' ? studio : clips; params.id = m[2]; }
    else if (h.startsWith('#/cuenta')) vista = cuenta;
    else if (h === '#/admin' && sesion.user.rol === 'admin') vista = admin;
    else { vista = inicio; if (h !== '#/') history.replaceState(null, '', '#/'); }
  }
  actual = vista; cabecera();
  try { await vista.montar(params); }
  catch (e) {
    if (yo !== turno) return;
    V.innerHTML = `<div class="note warn" role="alert">${esc(mensajeDe(e))}</div><div><a class="btn" href="#/">Volver a mis videos</a></div>`;
  }
}
addEventListener('hashchange', navegar);

(async function () {
  try {
    const [c, me] = await Promise.all([api('/config'), api('/me')]);
    sesion.cfg = c; sesion.user = me.user; sesion.saldo = me.saldo || null;
  } catch (e) { V.innerHTML = `<div class="note warn" role="alert">${esc(mensajeDe(e))}</div>`; return; }
  navegar();
})();
