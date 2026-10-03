// Analyse de sentiment volontairement simple (lexique FR/EN + émojis).
// Aucune API de plateforme ne fournit le sentiment : c'est une estimation, pas une vérité.
const POS = ['merci', 'super', 'top', 'génial', 'genial', 'bravo', 'excellent', 'parfait', 'magnifique', 'incroyable', 'adore', "j'adore",
  'love', 'great', 'awesome', 'amazing', 'nice', 'cool', 'beau', 'belle', 'bien', 'clair', 'utile', 'qualitatif', 'bluffant', 'hâte',
  'thanks', 'thank', 'perfect', 'good', 'fantastique', 'félicitations', 'felicitations', 'impressionnant', 'enfin', 'pépite'];
const NEG = ['nul', 'nulle', 'mauvais', 'horrible', 'déçu', 'decu', 'déception', 'arnaque', 'bug', 'planté', 'plante', 'pas d\'accord',
  'dommage', 'survendu', 'trop fort', 'trop rapide', 'marche pas', 'fonctionne pas', 'ne fonctionne', 'bad', 'worst', 'hate', 'terrible',
  'awful', 'scam', 'broken', 'déjà vu', 'inutile', 'nul à', 'problème', 'probleme', 'lent', 'cher'];
const POS_EMOJI = /[😍🥰😊😁👏🔥💯❤️💪🙌✨👍]/u;
const NEG_EMOJI = /[😡😠👎💩😤🤮😒]/u;

export function sentiment(text) {
  const t = ` ${String(text || '').toLocaleLowerCase('fr')} `;
  let score = 0;
  POS.forEach((w) => { if (t.includes(w)) score += 1; });
  NEG.forEach((w) => { if (t.includes(w)) score -= 1.2; });
  if (POS_EMOJI.test(t)) score += 1;
  if (NEG_EMOJI.test(t)) score -= 1;
  if (score >= 1) return 'positive';
  if (score <= -1) return 'negative';
  return 'neutral';
}
