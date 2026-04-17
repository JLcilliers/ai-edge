import { defineConfig } from 'drizzle-kit';

// Use unpooled connection for migrations (DDL can't go through pgbouncer).
// drizzle-kit doesn't auto-load .env.local — source it manually or use dotenv-cli.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
});
