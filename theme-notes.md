# Direction artistique du dashboard (« bento sombre »)

Fond noir, cartes #1a1a1a, **vert d'accent `#2bee2b` réservé à la marque, à l'action principale et au focus**. Aplats uniquement.
Police : Manrope auto-hébergée (assets/fonts, licence OFL) ; aucune requête vers Google Fonts. Chiffres tabulaires. Tous les jetons vivent dans `css/theme.css`, aucune couleur en dur ailleurs.

## Fichiers CSS (chargés par `<link>` dans index.html, ?v=15)
`theme.css` (jetons) · `base.css` (reset, typo, utilitaires) · `layout.css` (coque pleine largeur, en-tête collant, pilules, onglets mobiles) ·
`components.css` (composants de `js/ui/components.js`) · `legacy.css` (rendus hérités, à vider au fil des phases 3b/3c) ·
`pages-social.css` (3b, vide) · `pages-infra.css` (3c, vide) · `app.css` (simple `@import` pour les pages légales).

## Échelle typographique (7 tailles)
`--fs-1..7` = 12 / 13 / 14 / 16 / 20 / 28 / 48 px. Titre de page 28 px (poids 500). Valeurs de KPI 28 px (500), héros 48 px (400).
Espacements `--s-1..8` = 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Rayons : 12 (`--r-sm`) / 16 (`--r`) / 24 (`--r-lg`) / pilule.

## Rôles de couleur
| Rôle | Jeton | Valeur |
|---|---|---|
| Marque, action, focus | `--accent` | #2bee2b |
| ok (✓) | `--st-ok` sur `--st-ok-bg` | #f4f5f4 sur blanc 12 % |
| warn (triangle) | `--st-warn` | #ffc247 |
| error (✕) | `--st-error` | #ff8f87 |
| info (i) | `--st-info` | #9fbbd9 |
| pending (horloge) / neutral | `--st-pending` / `--st-neutral` | #c3c7c4 / #a8aca9 |
| Instagram / TikTok / LinkedIn | `--c-instagram/tiktok/linkedin` | #ff7ab8 / #e9ecea / #6cb4ff |
| Motifs de trait | `--dash-*` | continu / 6 4 / 2 3 |
| Jauges | `--meter-ok/warn/crit` | #e6e9e8 / #ffc247 / #ff8f87 (< 70 %, 70–89 %, ≥ 90 %) |
| Delta | `--delta-up/down/flat` | #f4f5f4 / #ffc247 / #a8aca9 (flèche + signe toujours) |

Statut = icône + libellé ; plateformes = couleur + motif de trait + libellé direct (légende), jamais la couleur seule.

## Ratios de contraste WCAG (calculés, script du scratchpad)
Sur #1a1a1a / #242424 / #0a0a0a : Instagram #ff7ab8 7,2 / 6,5 / 8,2 ; TikTok #e9ecea 14,6 / 13,1 / 16,6 ; LinkedIn #6cb4ff 8,0 / 7,1 / 9,1 ;
ambre 10,8 / 9,7 / 12,3 ; rouge 7,9 / 7,1 / 9,0 ; info 8,8 / 7,8 / 10,0 ; pending 10,2 / 9,1 / 11,6 ; gris #a8aca9 7,6 / 6,8 / 8,6 ; encre 15,9 / 14,2 / 18,1 ; #6f7471 (soft) 3,7 / 3,3 / 4,2.
Badges (texte sur fond teinté sur #1a1a1a) : ok 11,2 ; warn 7,9 ; error 6,2 ; info 6,5 ; pending 8,4.
Statuts sur cartes claires (blanc / #e6e9e8) : ok #1c201e 16,5 / 13,5 ; warn #6b4700 8,3 / 6,8 ; error #9a1c14 8,2 / 6,7 ; info #1d4a73 9,2 / 7,5 ; pending #454a48 9,0 / 7,4.
Jauges sur piste #3a3a3a : normal 9,3 ; attention 7,1 ; critique 5,2. Vert/#0a0a0a 12,6 ; bordure de champ #8a8f8c/#242424 4,7.
Séries Instagram/TikTok/LinkedIn : ≥ 3:1 (graphique) et distinctes par teinte (rose, blanc cassé, bleu) ET par motif de trait.

## Phase 3b : rayons, contrastes des pages sociales
Rayons (theme.css) : `--r-card` 12 (cartes, tuiles, dialogues) · `--r-ctl` 8 (boutons, champs, onglets, pastilles de navigation) · `--r-in` 6 (éléments internes) · `--r-badge` 6 (statuts, étiquettes) · `--r-bar` 2 (pistes de jauges). Seuls avatars (`.img--round`, `.avatar`) et points de légende restent à 50 %. Anciens noms `--r`, `--r-lg`, `--r-sm`, `--r-pill` conservés comme alias (pages 3c) : `--r-pill` vaut désormais 8 px.
Carte thermique TikTok : fond = `--ink` mélangé à `--surface-2` de 0 à 30 % (texte `--ink`) → ratio texte/fond ≥ 5,6 au plus clair (#636363 ≈ 5,6) ; la valeur est toujours écrite dans la case, la teinte n'est qu'un renfort ; cases < 3 vidéos en pointillés.

## Phase finale : mode en direct et cohérence globale
**Jetons retirés** (inutilisés, vérifiés par script) : alias de compatibilité `--pos/--neg/--warn-bg…`, `--paper/--raised/--tag-bg/--d-*/--shot-bar`, `--bar-1..5`, `--tint-1..3`, `--shell`, `--grey`, `--ink-dark-2`, `--muted-dark`, `--focus-dark`, `--st-*-dark`. Restent `--gray` et `--line-2` (lus par `js/charts.js`). Aucune couleur en dur hors `theme.css` (seule exception : `<meta name="theme-color">` des pages HTML, qui ne peut pas lire une variable CSS ; valeur = `--bg`). Rayons : aucun en dur (Chart.js lit `--r-ctl` et `--r-bar`), `50 %` réservé aux avatars et points. Tailles : uniquement `--fs-1..7`. Cache-bust `?v=15` partout (js, css, `login.html`, `conditions.html`, `confidentialite.html`).

**Indicateur « Mode en direct »** (composant `LiveIndicator`, en-tête de page) : icône + texte, jamais la couleur seule ; pastille neutre (`--surface`), jamais verte (le vert reste marque / action / focus). États : En direct · mis à jour il y a N s (âge de la DONNÉE : `updatedAt` / `sampleAt`, pas du dernier ping ; compteur recalculé sans `aria-live`) · Actualisation… · Connexion instable · Données en cache · En pause (onglet masqué / inactif) + « Reprendre » · Hors ligne · Désactivé + « Activer ». Pas de pulsation sous `prefers-reduced-motion` (règle globale de `base.css`).
Ratios WCAG (calculés) : texte et icône « En direct » `--ink` / `--surface` 15,9 · icône cache / instable `--st-warn` / `--surface` 10,8 · icône pause / hors ligne `--st-pending` / `--surface` 10,2 · bouton `--ink` / `--surface-2` 14,2 (bordure `--field-border` 4,7) · « Chargement… » d'un bloc et indication Dokploy `--muted` / `--surface` 7,6 · focus `--accent` / `--bg` 12,6 · `--on-accent` / `--accent` 12,6. Les squelettes (`--track` sur `--surface-2`, 1,4) sont décoratifs : l'information passe par le libellé masqué « Chargement des données… ».

**Accessibilité vérifiée** (9 routes chargées dans le navigateur) : un seul `h1` par page, un `header`, un `main`, un `footer`, `nav` étiquetés, focus sur le titre après navigation, `aria-live` parcimonieux (compteurs de tableaux et annonce Infrastructure uniquement ; ni l'indicateur ni la santé du serveur), alertes de l'en-tête non ré-annoncées à chaque mise à jour (le HTML n'est réécrit que s'il change).

## Jetons des réseaux (cache-bust `?v=15`)
Page Paramètres > Connexions sociales : colonne « Jeton » = StatusBadge de `token.health` (ok = neutre ✓ « Renouvelé automatiquement », renewing = info, reconnect_soon = ambre, reconnect_required = rouge, pending = horloge, non relié = neutre) + note du serveur + « Jeton d’accès (renouvelé automatiquement) » en information secondaire + « Dernier renouvellement ». Actions (ordre fixe) : Ouvrir la page · Actualiser les données · Renouveler le jeton · Reconnecter (`.btn-accent` vert seulement si reconnexion à prévoir / nécessaire) · Déconnecter (`.btn-danger` : fond neutre, texte et bordure `--st-error`, jamais vert). Le vert n’est jamais un statut.
Logique pure dans `js/core/token-logic.js` (libellés réexportés par `labels.js`) ; alerte globale uniquement pour `reconnect_soon` / `reconnect_required`, jamais à cause de l’échéance du jeton d’accès quand `autoRenew` est vrai. Boutons en cours / bloqués : `aria-disabled` (le focus reste sur le bouton après le re-rendu silencieux, attribut `data-conn-act` dans `FOCUS_ATTRS`).
