// Central configuration, read once from the environment. See .env.example for every variable.
import path from 'node:path';

const env = process.env;
const num = (v, d) => (v != null && v !== '' && Number.isFinite(+v) ? +v : d);

export const cfg = {
  port: num(env.PORT, 3000),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  appUrl: (env.APP_URL || '').replace(/\/$/, ''),
  production: env.NODE_ENV === 'production',

  // Claude
  model: env.CLAUDE_MODEL || 'claude-opus-5-5',
  effort: env.CLAUDE_EFFORT || 'medium',
  fallbacks: env.CLAUDE_FALLBACKS !== 'off',
  aiMock: env.AI_MOCK === '1',
  get hasAI() { return this.aiMock || !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN); },

  // Speech-to-text (optional): ElevenLabs Scribe gives word-level timings for subtitles and precise cuts.
  elevenKey: env.ELEVENLABS_API_KEY || '',
  sttModel: env.ELEVENLABS_STT_MODEL || 'scribe_v1',
  get hasSTT() { return this.aiMock || !!this.elevenKey; },

  // Accounts
  signupMode: ['open', 'invite', 'closed'].includes(env.SIGNUP_MODE) ? env.SIGNUP_MODE : (env.INVITE_CODE ? 'invite' : 'open'),
  inviteCode: env.INVITE_CODE || '',
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),

  // Plans: monthly credits. One credit is roughly one small Claude request (see COSTS below).
  plans: {
    free: { nombre: 'Gratis', creditos: num(env.PLAN_FREE_CREDITS, 40) },
    pro: { nombre: 'Pro', creditos: num(env.PLAN_PRO_CREDITS, 600) },
  },

  // Stripe (optional). Without these three variables the billing screens stay hidden.
  stripe: {
    key: env.STRIPE_SECRET_KEY || '',
    price: env.STRIPE_PRICE_ID || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  get hasBilling() { return !!(this.stripe.key && this.stripe.price && this.stripe.webhookSecret); },
};

// What each Claude action costs, in credits. The heavier ones send images of the video.
export const COSTS = { guion: 1, editar: 1, publicar: 1, montaje: 3, extractos: 4, afinar: 2, transcribir: 2 };
