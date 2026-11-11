// SQLite storage through Node's built-in driver: no native module to compile, one file to back up.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

fs.mkdirSync(cfg.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(cfg.dataDir, 'estudio.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL DEFAULT '',
    pass TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'user',
    plan TEXT NOT NULL DEFAULT 'free',
    perfil TEXT NOT NULL DEFAULT '{}',
    stripe_customer TEXT,
    stripe_sub TEXT,
    creado INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expira INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL DEFAULT 'video',
    nombre TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT '{}',
    mini TEXT NOT NULL DEFAULT '',
    creado INTEGER NOT NULL,
    actualizado INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id, actualizado DESC);
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accion TEXT NOT NULL,
    creditos INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    creado INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, creado);
`);

export const now = () => Date.now();
export const inicioMes = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

export function creditosUsados(userId) {
  return db.prepare('SELECT COALESCE(SUM(creditos),0) AS n FROM usage WHERE user_id = ? AND creado >= ?').get(userId, inicioMes()).n;
}
export function saldo(user) {
  const total = (cfg.plans[user.plan] || cfg.plans.free).creditos;
  const usados = creditosUsados(user.id);
  return { plan: user.plan, total, usados, quedan: Math.max(0, total - usados) };
}
export function registrarUso(userId, accion, creditos, usage) {
  db.prepare('INSERT INTO usage (user_id, accion, creditos, tokens_in, tokens_out, creado) VALUES (?,?,?,?,?,?)')
    .run(userId, accion, creditos, usage?.input_tokens || 0, usage?.output_tokens || 0, now());
}
