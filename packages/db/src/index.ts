import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

export * from './schema.js';

export function createDb(url: string) {
  return drizzle(neon(url), { schema });
}

export type Db = ReturnType<typeof createDb>;
