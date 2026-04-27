import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Symmetric encryption for OAuth tokens at rest (Phase B #6).
 *
 * Why we encrypt these. The access_token + refresh_token in
 * `gsc_connection` are full bearer credentials for the firm's Search
 * Console property. A leaked DB dump containing them lets an attacker
 * read the firm's organic search analytics indefinitely. Encrypting
 * with a separate key (env var, NOT in DB) means the attacker needs
 * both the DB dump AND the platform's runtime env to do anything.
 *
 * Algorithm. AES-256-GCM. Authenticated encryption — protects against
 * both confidentiality and tampering. The 16-byte auth tag is stored
 * alongside the ciphertext so we know whether a stored value has been
 * altered (e.g. by an attacker who got DB write access but not env).
 *
 * Storage format. `iv:tag:ciphertext` where each segment is hex.
 * 12 bytes IV (GCM standard), 16 bytes tag, variable ciphertext.
 *
 * Key sourcing. `OAUTH_TOKEN_ENCRYPTION_KEY` env var. Accepts:
 *   - 64 hex chars  → 32 raw bytes (preferred; full AES-256 entropy)
 *   - any other string → SHA-256 of the bytes (deterministic 32-byte key)
 * The hex-decode path is the canonical "give us a real key" form;
 * the SHA-256 fallback exists so a deploy that pastes a long random
 * passphrase still works without insisting on hex.
 *
 * Rotation. Out of scope for v1. When we need it, the format already
 * leaves room: prepend a `v1:` tag to the stored string and add a
 * `v2:` decoder when we rotate keys.
 */

function getKey(): Buffer {
  const raw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      'OAUTH_TOKEN_ENCRYPTION_KEY is not set — required to store Search Console OAuth tokens at rest',
    );
  }
  // Hex form preferred — 64 chars → 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // Fallback: SHA-256 of the input bytes. Deterministic; same input →
  // same key. This is what protects passphrase-style secrets.
  return createHash('sha256').update(raw).digest();
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptToken(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptToken: malformed token (expected iv:tag:ciphertext)');
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const key = getKey();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
