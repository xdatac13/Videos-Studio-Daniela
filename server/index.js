import { app } from './app.js';
import { cfg } from './config.js';
import { db, now } from './db.js';

db.prepare('DELETE FROM sessions WHERE expira < ?').run(now());

const server = app.listen(cfg.port, () => {
  console.log(`Estudio Daniela en http://localhost:${cfg.port}`);
  console.log(`  Claude: ${cfg.aiMock ? 'modo demostración (AI_MOCK=1)' : cfg.hasAI ? cfg.model : 'sin configurar (falta ANTHROPIC_API_KEY)'}`);
  console.log(`  Transcripción: ${cfg.aiMock ? 'demostración' : cfg.hasSTT ? 'ElevenLabs ' + cfg.sttModel : 'desactivada'} · Pagos: ${cfg.hasBilling ? 'Stripe' : 'desactivados'} · Registro: ${cfg.signupMode}`);
});
// Claude requests can run for minutes; keep sockets open well past that.
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 61000;

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); });
