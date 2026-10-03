// Primitives cryptographiques : AES-256-GCM, HMAC, comparaison en temps constant.
import crypto from 'node:crypto';

/** Chiffre une chaîne avec AES-256-GCM. keyHex = 64 caractères hex (32 octets). */
export function encrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Déchiffre ; lève une erreur si la clé est mauvaise ou si le contenu a été altéré. */
export function decrypt(box, keyHex) {
  if (!box || box.v !== 1 || box.alg !== 'aes-256-gcm') throw new Error('Format chiffré inconnu');
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

export function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** Comparaison en temps constant de deux chaînes de longueurs quelconques (via SHA-256). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb) && String(a ?? '').length === String(b ?? '').length;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
