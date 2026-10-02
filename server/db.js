import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.TURF_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(process.env.TURF_DB || join(DATA_DIR, 'turfconnect.sqlite'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
for (const file of readdirSync(join(ROOT, 'server', 'migrations')).filter(x => x.endsWith('.sql')).sort()) {
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(file)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(join(ROOT, 'server', 'migrations', file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(file, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${file} failed: ${e.message}`); }
  }
}

export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

// BEGIN IMMEDIATE takes the write lock up front, so a read-check-write sequence inside fn cannot interleave with
// another writer (another process included). Nested calls join the outer transaction.
let depth = 0;
export function transaction(fn) {
  if (depth) return fn();
  db.exec('BEGIN IMMEDIATE'); depth++;
  try { const result = fn(); depth--; db.exec('COMMIT'); return result; }
  catch (e) { depth--; db.exec('ROLLBACK'); throw e; }
}

export const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
