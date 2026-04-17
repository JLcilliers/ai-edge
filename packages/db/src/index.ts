import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

export * from './schema';

export function createDb(url: string) {
  return drizzle(neon(url), { schema });
}

export type Db = ReturnType<typeof createDb>;

// Lazy singleton for Next.js (safe at build time — only connects on first call).
let _db: Db | null = null;

export function getDb(): Db {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _db = createDb(url);
  }
  return _db;
}
