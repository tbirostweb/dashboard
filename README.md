# Dashboard BirostWeb

Dashboard français responsive réunissant Instagram, TikTok, LinkedIn et l’infrastructure Dokploy. Direction visuelle graphite, ivoire et bleu désaturé ; les vues affichent uniquement des données réelles. LinkedIn reste « En attente d’approbation » tant que Community Management API n’est pas accordée.

Le guide de déploiement, de connexion OAuth et de configuration Dokploy se trouve dans [connexion.md](connexion.md). Le modèle des variables est [.env.example](.env.example). Ne commitez jamais un vrai fichier `.env`.

## Architecture

- `web` : nginx sert le frontend HTML/CSS/JavaScript et les pages publiques `/confidentialite`, `/conditions`, puis relaie `/api` vers le backend.
- `api` : Node.js gère la session existante, OAuth, les appels sociaux et Dokploy. Les secrets restent côté serveur.
- `api-data` : volume persistant des tokens OAuth chiffrés et des relevés d’abonnés.
- Navigation : Vue d’ensemble, Réseaux sociaux, Infrastructure, Déploiements, Paramètres.

## Déployer

Créez un service **Docker Compose** dans Dokploy depuis le dépôt, avec `./docker-compose.yml`. Renseignez les variables de `.env.example`, puis associez le domaine HTTPS au service `web`, port 80. N’exposez pas `api`. Le frontend seul ne permet pas les parcours authentifiés.

Pour relier l’infrastructure, ajoutez `DOKPLOY_URL` (URL de l’instance de gestion Dokploy) et `DOKPLOY_API_KEY` dans Environment. Ces valeurs sont injectées dans le backend uniquement. Consultez [la configuration détaillée et les limites](connexion.md#10-relier-linfrastructure-dokploy-au-dashboard).

Sans identifiants sociaux ou Dokploy, l’interface affiche les états de déconnexion et les données manquantes ; elle n’utilise pas les chiffres de la maquette.

## Vérifier

```bash
cd backend
npm test
```

Après déploiement, vérifiez `/healthz`, `/api/health`, la connexion par mot de passe et les pages légales publiques. Les tests utilisent des réponses simulées pour exercer les erreurs et les permissions ; ils ne prouvent pas que vos comptes ou votre instance sont configurés. Une requête de redéploiement exige confirmation puis suivi de son résultat.

## Monitoring et journaux Dokploy

La connexion à l’API et la disponibilité des mesures sont deux états distincts. L’interface indique monitoring natif ou agent avancé, source et date ; les mesures anciennes restent indisponibles. Le stockage natif mesure le système de fichiers racine, pas tous les disques. Le repli natif ne nécessite pas d’ouvrir le port 4500.

La lecture des journaux dépend des transports réellement disponibles dans Dokploy : REST ou flux officiel relayé et filtré par le backend. L’absence de `deployment.readLogs` en v0.26.5 ne suffit pas à désactiver toute consultation. Si l’accès est indisponible, « Voir dans Dokploy » ouvre le service identifié ; ouvrez sa section Déploiements. Aucun secret, chemin de journal arbitraire ni jeton n’est transmis au navigateur.
