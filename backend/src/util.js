// Petits utilitaires partagés.

/** Exécute fn sur chaque élément avec au plus `limit` appels simultanés. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Date locale (fuseau du process, TZ) au format AAAA-MM-JJ. */
export function isoDay(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Normalise les horodatages Meta ("2024-05-01T12:00:00+0000") en ISO 8601 standard. */
export function toIso(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Première ligne d'un texte, tronquée proprement. */
export function titleFrom(text, fallback, max = 90) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
