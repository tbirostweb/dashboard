// Vérifie DASHBOARD_PASSWORD contre la base Have I Been Pwned (k-anonymity) SANS envoyer le mot de passe ni son empreinte complète :
// seuls les 5 premiers caractères hexadécimaux du SHA-1 partent sur le réseau ; la comparaison du suffixe se fait localement.
// Usage (poste de l'opérateur, hors production) :  DASHBOARD_PASSWORD='…' npm run check-password
// Aucune valeur n'est affichée. Code de sortie : 0 = non trouvé, 2 = compromis, 1 = erreur / absent.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

export async function pwnedCount(password, { fetch = globalThis.fetch } = {}) {
  const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5), suffix = sha1.slice(5);
  const res = await fetch(`${HIBP_RANGE_URL}${prefix}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'social-dashboard-password-check' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HIBP indisponible (HTTP ${res.status})`);
  for (const line of (await res.text()).split(/\r?\n/)) {
    const [hash, count] = line.trim().split(':');
    if (hash === suffix) return Number.parseInt(count, 10) || 0;
  }
  return 0;
}

async function main() {
  const pw = process.env.DASHBOARD_PASSWORD || '';
  if (!pw) { console.error('DASHBOARD_PASSWORD absent de l’environnement.'); process.exit(1); }
  const count = await pwnedCount(pw);
  if (count > 0) { console.error('COMPROMIS : ce mot de passe figure dans des fuites publiques. Changez-le (Dokploy > Environment) puis Redeploy.'); process.exit(2); }
  console.log('OK : mot de passe absent de la base Have I Been Pwned.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((err) => { console.error(`Vérification impossible : ${err.message}`); process.exit(1); });
