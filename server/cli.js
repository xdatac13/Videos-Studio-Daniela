// Small admin commands for the person who hosts the studio.
//   npm run reset-password -- correo@ejemplo.com NuevaClave123
//   npm run set-plan -- correo@ejemplo.com pro
import { db } from './db.js';
import { hashPass } from './auth.js';
import { cfg } from './config.js';

const [cmd, emailArg, valor] = process.argv.slice(2), email = String(emailArg || '').toLowerCase();
const u = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const salir = (msg, code = 1) => { console.log(msg); process.exit(code); };

if (!['reset-password', 'set-plan', 'make-admin'].includes(cmd)) salir('Comandos: reset-password <correo> <clave> · set-plan <correo> <free|pro> · make-admin <correo>');
if (!u) salir(`No hay ninguna cuenta con el correo "${email}".`);

if (cmd === 'reset-password') {
  if (!valor || valor.length < 8) salir('La nueva contraseña necesita al menos 8 caracteres.');
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(valor), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  salir(`Contraseña cambiada para ${email}.`, 0);
}
if (cmd === 'set-plan') {
  if (!cfg.plans[valor]) salir(`Plan desconocido. Usa: ${Object.keys(cfg.plans).join(', ')}`);
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(valor, u.id);
  salir(`${email} ahora tiene el plan ${valor}.`, 0);
}
if (cmd === 'make-admin') {
  db.prepare("UPDATE users SET rol = 'admin' WHERE id = ?").run(u.id);
  salir(`${email} ahora es administradora.`, 0);
}
