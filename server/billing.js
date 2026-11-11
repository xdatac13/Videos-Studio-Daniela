// Optional Stripe subscription for the Pro plan. Uses Stripe's REST API directly (no SDK to keep
// the install small). Active only when STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET are set.
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { db } from './db.js';

async function stripe(ruta, params) {
  const r = await fetch('https://api.stripe.com/v1/' + ruta, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.stripe.key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('[stripe]', ruta, r.status, j?.error?.message); throw new Error('stripe'); }
  return j;
}

export async function crearCheckout(user, origen) {
  const p = {
    mode: 'subscription',
    'line_items[0][price]': cfg.stripe.price,
    'line_items[0][quantity]': '1',
    success_url: `${origen}/#/cuenta?pago=ok`,
    cancel_url: `${origen}/#/cuenta`,
    client_reference_id: String(user.id),
    allow_promotion_codes: 'true',
  };
  if (user.stripe_customer) p.customer = user.stripe_customer; else p.customer_email = user.email;
  return (await stripe('checkout/sessions', p)).url;
}

export async function crearPortal(user, origen) {
  if (!user.stripe_customer) throw new Error('sin cliente');
  return (await stripe('billing_portal/sessions', { customer: user.stripe_customer, return_url: `${origen}/#/cuenta` })).url;
}

// Stripe signs "<timestamp>.<raw body>" with the endpoint secret (header: t=...,v1=...).
export function firmaValida(cuerpo, cabecera, secreto, ahora = Date.now(), toleranciaS = 300) {
  const partes = Object.create(null);
  for (const kv of String(cabecera || '').split(',')) { const i = kv.indexOf('='); if (i > 0) (partes[kv.slice(0, i).trim()] ||= []).push(kv.slice(i + 1).trim()); }
  const t = partes.t?.[0];
  if (!t || !partes.v1 || Math.abs(ahora / 1000 - +t) > toleranciaS) return false;
  const esperado = crypto.createHmac('sha256', secreto).update(`${t}.`).update(cuerpo).digest();
  return partes.v1.some(v => { const b = Buffer.from(v, 'hex'); return b.length === esperado.length && crypto.timingSafeEqual(b, esperado); });
}

export function recibirEvento(ev) {
  const o = ev?.data?.object || {};
  if (ev.type === 'checkout.session.completed' && o.client_reference_id) {
    db.prepare("UPDATE users SET plan = 'pro', stripe_customer = ?, stripe_sub = ? WHERE id = ?").run(o.customer || null, o.subscription || null, +o.client_reference_id);
  } else if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    const activa = ev.type !== 'customer.subscription.deleted' && ['active', 'trialing', 'past_due'].includes(o.status);
    db.prepare('UPDATE users SET plan = ?, stripe_sub = ? WHERE stripe_customer = ?').run(activa ? 'pro' : 'free', activa ? o.id : null, o.customer || '');
  }
}
