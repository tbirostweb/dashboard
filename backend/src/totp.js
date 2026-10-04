// Second facteur TOTP (RFC 6238, HMAC-SHA1, 6 chiffres, pas de 30 s) sans dépendance externe.
// Le secret (base32) vient uniquement de l'Environment (DASHBOARD_TOTP_SECRET) : jamais renvoyé ni journalisé.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_MIN_SECRET_CHARS = 16; // 80 bits ; 32 caractères (160 bits) recommandés

/** Normalise un secret base32 (espaces, tirets, padding, casse). Renvoie '' si invalide. */
export function normalizeBase32(input) {
  const s = String(input || '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  return /^[A-Z2-7]+$/.test(s) ? s : '';
}

export function base32Decode(input) {
  const s = normalizeBase32(input);
  if (!s) throw new Error('base32 invalide');
  let bits = 0, value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Génère un nouveau secret base32 de 160 bits (pour la documentation / l'opérateur). */
export function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpAt(secret, nowMs) {
  return hotp(base32Decode(secret), Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
}

/**
 * Vérificateur TOTP avec fenêtre ±1 pas (dérive d'horloge) et ANTI-REJEU : un pas déjà accepté
 * (ou antérieur) est refusé, même pour une autre action. Renvoie 'ok' | 'invalid' | 'replay'.
 */
export class TotpVerifier {
  constructor({ secret, now = () => Date.now(), window = 1 } = {}) {
    this.key = secret ? base32Decode(secret) : null;
    this.now = now;
    this.window = window;
    this.lastCounter = -1;
  }

  get enabled() { return Boolean(this.key); }

  verify(code) {
    if (!this.key) return 'invalid';
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return 'invalid';
    const current = Math.floor(this.now() / 1000 / TOTP_STEP_SECONDS);
    for (let d = -this.window; d <= this.window; d++) {
      const counter = current + d;
      const expected = hotp(this.key, counter);
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
        if (counter <= this.lastCounter) return 'replay';
        this.lastCounter = counter;
        return 'ok';
      }
    }
    return 'invalid';
  }
}
