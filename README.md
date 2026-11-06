# Dashboard BirostWeb

Dashboard français responsive réunissant Instagram, TikTok, LinkedIn, ainsi que les statistiques du site (Umami, Search Console, Google Analytics 4). Direction visuelle graphite, ivoire et bleu désaturé ; les vues affichent uniquement des données réelles. LinkedIn reste « En attente d’approbation » tant que Community Management API n’est pas accordée.

Le guide de déploiement et de connexion OAuth se trouve dans [connexion.md](connexion.md). Le modèle des variables est [.env.example](.env.example). Ne commitez jamais un vrai fichier `.env`.

## Architecture

- `web` : nginx sert le frontend HTML/CSS/JavaScript et les pages publiques `/confidentialite`, `/conditions`, puis relaie `/api` vers le backend.
- `api` : Node.js gère la session, OAuth, les appels sociaux, Umami et Google. Les secrets restent côté serveur.
- `api-data` : volume persistant des tokens OAuth chiffrés et des relevés d’abonnés.
- Navigation (4 entrées) : Accueil, Site web (Visiteurs / Google), Réseaux sociaux, Paramètres.
- Analytics : fréquentation de birostweb.fr lue dans Umami (lecture seule, appels côté `api`). Facultatif : renseignez `UMAMI_BASE_URL`, `UMAMI_WEBSITE_ID` et `UMAMI_API_KEY` (ou `UMAMI_USERNAME` + `UMAMI_PASSWORD`), voir `.env.example`. Sans elles, l’onglet affiche « non configuré ».
- Google Analytics 4 (utilisateurs, sessions, pages vues, événements) : `GA4_PROPERTY_ID` + le compte de service de Search Console, voir [docs/google-analytics.md](docs/google-analytics.md).
- SEO : référencement Google lu dans Search Console (lecture seule, compte de service). Facultatif : `GSC_SITE_URL`, `GSC_CLIENT_EMAIL`, `GSC_PRIVATE_KEY`, voir `.env.example`.

## Déployer

Créez un service **Docker Compose** dans Dokploy depuis le dépôt, avec `./docker-compose.yml`. Renseignez les variables de `.env.example`, puis associez le domaine HTTPS au service `web`, port 80. N’exposez pas `api`. Le frontend seul ne permet pas les parcours authentifiés.

Sans identifiants sociaux, l’interface affiche les états de déconnexion et les données manquantes ; elle n’utilise pas les chiffres de la maquette.

## Vérifier

```bash
cd backend
npm test
```

Après déploiement, vérifiez `/healthz`, `/api/health`, la connexion par mot de passe et les pages légales publiques. Les tests utilisent des réponses simulées pour exercer les erreurs et les permissions ; ils ne prouvent pas que vos comptes ou votre instance sont configurés.
