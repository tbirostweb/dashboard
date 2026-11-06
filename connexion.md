# Connecter TikTok, Instagram et LinkedIn au dashboard

Guide pas à pas pour mettre le dashboard en ligne sur **Dokploy** puis y relier les vrais comptes.

> **À lire d'abord.** Les portails développeurs (TikTok, Meta, LinkedIn) changent souvent d'intitulés, de permissions et de délais. Ce guide a été rédigé sans accès à ces portails ni aux vraies API : le code est testé avec des réponses **simulées**, conformes à la documentation officielle. Si un libellé diffère, suivez la doc officielle (liens dans chaque section) et gardez les **URL de redirection** indiquées ici, qui, elles, sont fixées par le code.

---

## 0. Architecture en 3 lignes

1. **web** (nginx) sert le site statique et les pages publiques `/confidentialite` et `/conditions`, et relaie `/api/*` vers le backend.
2. **api** (Node.js, réseau interne, jamais exposé) gère la connexion par mot de passe, l'OAuth des plateformes, et interroge les API.
3. Les tokens OAuth sont **chiffrés (AES-256-GCM)** dans le volume Docker `api-data` (`/data`) ; ils ne sont jamais envoyés au navigateur.

## URL à déclarer (domaine : `dashboard.birostweb.fr`)

| Usage | URL exacte |
|---|---|
| Site / Website URL | `https://dashboard.birostweb.fr` |
| Politique de confidentialité (Privacy policy URL) | `https://dashboard.birostweb.fr/confidentialite` |
| Conditions d'utilisation (Terms of Service URL) | `https://dashboard.birostweb.fr/conditions` |
| Redirect LinkedIn | `https://dashboard.birostweb.fr/api/auth/linkedin/callback` |
| Redirect Instagram | `https://dashboard.birostweb.fr/api/auth/instagram/callback` |
| Redirect TikTok | `https://dashboard.birostweb.fr/api/auth/tiktok/callback` |
| Logo de l'app | fichier `assets/linkedin-app-logo.png` (640 × 640 px, 24 Ko), aussi servi sur `https://dashboard.birostweb.fr/assets/linkedin-app-logo.png` |

Règle d'or : redirect URI = `PUBLIC_URL` + `/api/auth/<plateforme>/callback`, **au caractère près** (https, pas de `/` final, pas de `www`).

---

## 1. Déployer sur Dokploy

### 1.1 Préparer le DNS
Chez le registrar de `birostweb.fr`, créez un enregistrement **A** `dashboard` → adresse IP du VPS (et **AAAA** si IPv6). Attendez qu'il se propage (`dig +short dashboard.birostweb.fr`).

### 1.2 Mettre le code à disposition de Dokploy
Dokploy construit le compose à partir d'un dépôt Git (GitHub, GitLab, Gitea, Bitbucket ou Git générique). Poussez ce dossier dans un **dépôt privé** (le fichier `.env` ne doit jamais y être : il est ignoré par `.dockerignore`, ajoutez-le aussi à `.gitignore`).
Le mode « Raw » (compose collé à la main) ne convient pas : il ne permet pas de construire les images depuis les `Dockerfile` du dépôt.

### 1.3 Créer le service Compose
1. Dokploy → votre projet → **Create Service** → **Compose**.
2. **Compose Type** : `Docker Compose`.
3. **Provider** : votre dépôt, branche `main`, **Compose Path** : `./docker-compose.yml`.
4. Si une ancienne « Application » Dokploy (Dockerfile seul) utilise déjà ce domaine, retirez-lui le domaine (ou supprimez-la) pour éviter un conflit de routage.

### 1.4 Variables d'environnement (onglet **Environment**)
Générez deux secrets différents sur votre machine :
```bash
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY
```
Collez dans **Environment** (modèle complet et commenté : `.env.example`) :
```dotenv
PUBLIC_URL=https://dashboard.birostweb.fr
DASHBOARD_PASSWORD=<longue phrase de passe, 12 caractères min.>
SESSION_SECRET=<résultat openssl n°1>
TOKEN_ENCRYPTION_KEY=<résultat openssl n°2>
MOCK_FALLBACK=false
LINKEDIN_CLIENT_ID=<Client ID LinkedIn>
LINKEDIN_CLIENT_SECRET=<Primary Client Secret LinkedIn>
LINKEDIN_ORGANIZATION_ID=000000000
LINKEDIN_COMMUNITY_API=false
LINKEDIN_SCOPES=
LINKEDIN_API_VERSION=202609
# Instagram / TikTok : à remplir quand les apps existent (voir §3 et §4)
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```
Dokploy écrit ces valeurs dans un fichier `.env` à côté du compose, lu par le service `api`. Sans `DASHBOARD_PASSWORD`, `SESSION_SECRET` et `TOKEN_ENCRYPTION_KEY` valides, **l'API refuse de démarrer** (les valeurs d'exemple sont refusées). Le site statique, `/confidentialite` et `/conditions` restent servis même dans ce cas (mais `/api/*` répond **502 Bad Gateway** et le conteneur `api` apparaît en « restarting »).

**Format des valeurs (fichier `.env` lu par Docker Compose)** — vérifié avec Docker Compose 2.40 :
- `#` **collé** à la valeur est conservé (`MOT#DEPASSE` → `MOT#DEPASSE`), mais un `#` **précédé d'un espace** commence un commentaire et **tronque** la valeur (`abc #def` → `abc`) : un mot de passe ainsi tronqué sous 12 caractères fait planter l'API.
- `$` est interprété comme une variable (`ab$cd` → `ab`) : évitez `$` ou écrivez `$$`.
- `=`, `.`, `-`, `_` sont sans risque (un secret finissant par `==` est lu tel quel).
- Pas de guillemets ni d'espaces autour du `=`. En cas de doute, choisissez un mot de passe sans `#`, `$`, espace ni guillemet.
- `SESSION_SECRET` et `TOKEN_ENCRYPTION_KEY` : deux sorties **différentes** de `openssl rand -hex 32` (64 caractères hexadécimaux chacune ; identiques = refus de démarrer).

### 1.5 Domaine et HTTPS (onglet **Domains**)
**Add Domain** : Host `dashboard.birostweb.fr`, Path `/`, **Service Name** `web`, **Container Port** `80`, **HTTPS** activé, Certificate **Let's Encrypt**. Ne créez aucun domaine pour `api`.

### 1.6 Déployer et vérifier
Cliquez **Deploy**, puis :
- `https://dashboard.birostweb.fr/healthz` → `ok`
- `https://dashboard.birostweb.fr/api/health` → `{"ok":true,…}`
- `https://dashboard.birostweb.fr/confidentialite` → page affichée **sans mot de passe**
- `https://dashboard.birostweb.fr/conditions` → page affichée **sans mot de passe**
- `https://dashboard.birostweb.fr/` → redirige vers la page de connexion.

Si le domaine répond 404 ou « Bad Gateway » alors que les conteneurs tournent : vérifiez dans Dokploy que le service `web` est bien rattaché au réseau `dokploy-network` (les versions récentes le font quand le domaine est ajouté via l'onglet Domains ; sinon ajoutez ce réseau `external: true` au service `web` dans le compose).

### 1.7 Volume
Le volume nommé `api-data` (tokens chiffrés + historique des abonnés) est créé automatiquement et **survit aux redéploiements**. Sauvegarde possible via les *Volume Backups* de Dokploy. Le supprimer efface toutes les connexions (il faudra reconnecter les comptes). Si vous changez `TOKEN_ENCRYPTION_KEY`, l'API ne pourra plus lire le volume : supprimez-le puis reconnectez.

---

## 2. LinkedIn (Page BirostWeb, id <ID_PAGE> — app LinkedIn n° 266544895)

> L'« App ID » 266544895 visible dans l'URL du portail n'est **pas** le Client ID OAuth. Le Client ID et le Client Secret sont dans l'onglet **Auth** de l'app.

### 2.1 État actuel : « En attente d'approbation LinkedIn »
La demande *Community Management API* (Development Tier) est soumise mais pas encore approuvée. L'onglet **Auth** affiche donc « No permissions added ». Dans cet état, avec `LINKEDIN_COMMUNITY_API=false` :
- le dashboard affiche un bandeau **« En attente d'approbation LinkedIn »** avec les étapes restantes (vue d'ensemble, page LinkedIn, barre latérale) ;
- **aucune** statistique LinkedIn n'est affichée, ni réelle ni fictive ; TikTok et Instagram ne changent pas ;
- aucun bouton « Connecter LinkedIn » : `/api/auth/linkedin/login` renvoie vers le dashboard sans appeler LinkedIn (aucun scope ne pourrait être accordé) ;
- `/api/status` renvoie `"status": "pending_approval"` pour LinkedIn, et les endpoints de données renvoient `409 {"error":"pending_approval"}`.

Même avec `LINKEDIN_COMMUNITY_API=true`, si LinkedIn répond `403 ACCESS_DENIED` sur les endpoints organisation (`organizations/{id}` et `networkSizes`), le dashboard repasse automatiquement en « en attente d'approbation ».

### 2.2 Scopes nécessaires (vérifiés dans la documentation officielle, version 202609)
| Appel utilisé par le dashboard | Scope | Source |
|---|---|---|
| `GET /rest/organizations/{id}` (nom, vanityName) | `rw_organization_admin` | [Organization Lookup](https://learn.microsoft.com/linkedin/marketing/community-management/organizations/organization-lookup-api) |
| `GET /rest/networkSizes/urn:li:organization:{id}?edgeType=COMPANY_FOLLOWED_BY_MEMBER` (abonnés) | `rw_organization_admin` (listé sur la page Organization Lookup) | idem |
| `GET /rest/organizationalEntityFollowerStatistics` (gains quotidiens, 12 mois → J-2) | `rw_organization_admin` | [Follower Statistics](https://learn.microsoft.com/linkedin/marketing/community-management/organizations/follower-statistics) |
| `GET /rest/organizationalEntityShareStatistics` (impressions, réactions, commentaires, republications ; 12 mois glissants) | `rw_organization_admin` | [Share Statistics](https://learn.microsoft.com/linkedin/marketing/community-management/organizations/share-statistics) |
| `GET /rest/posts?q=author&author=urn:li:organization:{id}` | `r_organization_social` | [Posts API](https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api) |
| `GET /rest/socialActions/{urn}/comments` | `r_organization_social_feed` | [Comments API](https://learn.microsoft.com/linkedin/marketing/community-management/shares/comments-api) |

Tous ces appels exigent que le compte connecté soit **ADMINISTRATOR** de la Page. Chaque requête envoie les en-têtes `Linkedin-Version: 202609` et `X-Restli-Protocol-Version: 2.0.0` ([Versioning](https://learn.microsoft.com/linkedin/marketing/versioning) : version « Latest » = 202609, versions garanties au moins 1 an ; la 202510 est retirée le 15/10/2026).

Scopes demandés par défaut (`LINKEDIN_SCOPES` vide) : `r_organization_social rw_organization_admin`. Ajoutez `r_organization_social_feed` **seulement** s'il apparaît dans l'onglet Auth après approbation : demander un scope non accordé fait échouer toute l'autorisation.

Points **non confirmés** : la liste exacte des scopes accordés au Development Tier (elle ne sera visible que dans l'onglet Auth après approbation) ; le scope exact de `networkSizes` (non indiqué à part dans la doc, déduit du tableau de la page Organization Lookup) ; la disponibilité de `r_organization_social_feed` pour cette app.

### 2.3 Champs de l'app (LinkedIn Developers)
- **App name** : `BirostWeb Social Dashboard` (ni « Linked » ni « In » dans le nom ou le logo : exigence de LinkedIn).
- **LinkedIn Page** : BirostWeb (`linkedin.com/company/<ID_PAGE>`), **vérifiée** par un super administrateur (Settings → Verify → URL à ouvrir par l'admin).
- **Privacy policy URL** : `https://dashboard.birostweb.fr/confidentialite`
- **App logo** : `assets/linkedin-app-logo.png` (640 × 640, 24 Ko)
- **Products** : uniquement *Community Management API* (LinkedIn n'accepte la demande Development Tier que sur une app sans autre produit). Le formulaire demande une adresse e-mail professionnelle vérifiée, la raison sociale, l'adresse, le site et la politique de confidentialité. Cas d'usage proposé (usage interne) :
  > Internal analytics dashboard for BirostWeb's own LinkedIn Page (organization <ID_PAGE>). Read-only: we retrieve follower counts, post statistics (impressions, reactions, comments, reposts) and comments on our own posts to report on our social media performance. Used only by our team behind a password; no posting, no data resale or sharing, no access to other organizations. Tokens are stored encrypted on our server. Privacy policy: https://dashboard.birostweb.fr/confidentialite
- **Auth → Authorized redirect URLs for your app** : ajoutez exactement
  `https://dashboard.birostweb.fr/api/auth/linkedin/callback`
  (https, sans `/` final, sans `www`). Le code la construit comme `PUBLIC_URL` + `/api/auth/linkedin/callback`, et un test automatisé vérifie qu'elle correspond au caractère près.

### 2.4 Variables Dokploy (dès maintenant)
```dotenv
LINKEDIN_CLIENT_ID=<Client ID, onglet Auth>
LINKEDIN_CLIENT_SECRET=<Primary Client Secret, onglet Auth>
LINKEDIN_ORGANIZATION_ID=000000000
LINKEDIN_COMMUNITY_API=false
LINKEDIN_SCOPES=
LINKEDIN_API_VERSION=202609
```
Le secret n'est lu que par le service `api`. Il n'est ni dans le front, ni dans les images Docker, ni dans les réponses d'API ou les logs (vérifié par tests et par grep). `.env` est exclu par `.gitignore` et `.dockerignore`.

### 2.5 Procédure de test après approbation
1. LinkedIn envoie la confirmation. Dans **Products**, *Community Management API* apparaît comme accordé (Development Tier).
2. Onglet **Auth** : notez les scopes listés sous *OAuth 2.0 scopes*. Il faut au minimum `r_organization_social` et `rw_organization_admin`. Vérifiez que la redirect URL du §2.3 est enregistrée.
3. Dokploy → Environment : `LINKEDIN_COMMUNITY_API=true`. Si `r_organization_social_feed` est listé et que vous voulez les commentaires, mettez `LINKEDIN_SCOPES=r_organization_social rw_organization_admin r_organization_social_feed`. Puis **Redeploy**.
4. Sur le dashboard, le bandeau « en attente » disparaît et le bouton **Connecter LinkedIn** apparaît. Cliquez-le avec un compte **super administrateur** de la Page <ID_PAGE>, puis acceptez les autorisations.
5. Ouvrez `https://dashboard.birostweb.fr/api/status` (connecté au dashboard) : `linkedin.status` doit valoir `connected`, avec `expiresAt` environ 60 jours plus tard.
6. Ouvrez `https://dashboard.birostweb.fr/api/debug/linkedin` (diagnostic, protégé par le mot de passe du dashboard). Il teste un à un `organizations`, `networkSizes`, `posts`, `shareStatistics`, `followerStatistics` et `comments`. Il indique pour chacun `ok`, le statut HTTP et le scope concerné, et dans `firstFailure` la première étape en échec. Aucun token n'y figure.
7. Page LinkedIn du dashboard : abonnés, publications et impressions de la Page. Une note en haut de page liste ce qui manque éventuellement (par exemple les commentaires sans `r_organization_social_feed`).

Interprétation rapide du diagnostic :
| `firstFailure` | Cause probable |
|---|---|
| `LINKEDIN_COMMUNITY_API=false` | Toujours en attente : rien n'est appelé. |
| `Aucun token` | Cliquez « Connecter LinkedIn ». |
| `organizations/{id} … 403` | Scope `rw_organization_admin` non accordé, ou compte non admin de la Page. |
| `posts?q=author … 403` | Scope `r_organization_social` non accordé. |
| `socialActions … 403` | `r_organization_social_feed` non demandé ou non accordé (seuls les commentaires manquent). |
| `… 426` ou message sur la version | `LINKEDIN_API_VERSION` retirée : passez à la dernière version de la doc. |

**Important** : l'OAuth LinkedIn réel n'a pas pu être testé, puisque l'approbation n'est pas encore obtenue. Tout le flux est couvert par des tests automatisés avec des réponses simulées conformes à la documentation, mais le premier vrai branchement reste à faire (étapes ci-dessus).

### 2.6 Tokens LinkedIn
Access token valable **60 jours**. Le refresh token n'est fourni qu'à certaines apps : s'il existe, le backend le rafraîchit seul ; sinon, reconnectez LinkedIn avant l'échéance (`expiresAt` dans `/api/status`).

### 2.7 Solution de repli : export manuel
En attendant l'approbation, LinkedIn permet d'exporter les analytics de la Page (Page → Analytics → Exporter, fichier XLS/CSV). **L'import de ces fichiers n'est pas implémenté** dans le dashboard : c'est une évolution possible.

---

## 3. Instagram (compte professionnel)

Doc : <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login>

Prérequis : compte Instagram **professionnel** (Business ou Créateur). Avec « Instagram API with Instagram Login », la liaison à une Page Facebook n'est **pas** nécessaire. Elle l'est si vous choisissez l'autre variante (*Instagram API with Facebook Login*, non implémentée ici).

1. <https://developers.facebook.com/apps/> → **Create app** → cas d'usage *Manage messaging & content on Instagram* (ou type **Business**).
2. Produit **Instagram** → **API setup with Instagram login**. Notez l'**Instagram App ID** et l'**Instagram App Secret** (et non l'App ID Facebook) → `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`.
3. *Set up Instagram business login* → **OAuth redirect URIs** : `https://dashboard.birostweb.fr/api/auth/instagram/callback`.
4. Permissions : `instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_comments`.
5. Mode test : **App roles → Roles** → ajoutez votre compte Instagram comme *Instagram Tester*, puis acceptez l'invitation dans Instagram (Paramètres → Apps et sites web → Invitations de testeur). Pour vos propres comptes ayant un rôle sur l'app, l'accès standard suffit généralement. L'**App Review** (plusieurs jours à semaines, avec vidéo) n'est nécessaire que pour des comptes sans rôle sur l'app.
6. Renseignez aussi la **Privacy Policy URL** dans *App settings → Basic*.

Tokens : token court (1 h) échangé automatiquement contre un token **long de 60 jours**, rafraîchi par le backend quand il reste moins de 7 jours (vérification toutes les 6 h). Si le dashboard n'a pas tourné pendant plus de 60 jours, reconnectez.

### 3.1 Insights du compte (page Instagram : Vues, Interactions, Profil, Audience)

Source vérifiée le 01/10/2026 : [Instagram User Insights](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights) (dernière version Graph : v26.0 ; `INSTAGRAM_GRAPH_VERSION` reste à `v23.0` par défaut, toujours prise en charge). Voir aussi le [changelog](https://developers.facebook.com/docs/instagram-platform/changelog) et [Media Insights](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights).

**Scopes : inchangés** (`instagram_business_basic` + `instagram_business_manage_insights`, déjà demandés). Aucune reconnexion nécessaire.

Route du backend : `GET /api/platforms/instagram/insights?period=7|30|90` (protégée par la session). Appels `GET /me/insights?metric=…&metric_type=total_value&period=day&since=…&until=…` pour la période et la période précédente (variation). Chaque métrique est isolée : si Meta en refuse une, elle est simplement absente du dashboard (et listée dans une note discrète) ; les autres restent affichées. Cache : même TTL que le reste (`CACHE_TTL_SECONDS`), une entrée par période.

| Bloc du dashboard | Métrique API | Détail |
|---|---|---|
| Vues (total) | `views` | |
| Vues followers / non-followers | `views` + `breakdown=follower_type` | FOLLOWER / NON_FOLLOWER |
| Vues par type de contenu | `views` + `breakdown=media_product_type` | Reels, publications, carrousels, stories |
| Spectateurs (+ followers / non-followers) | `reach` (+ `breakdown=follow_type`) | comptes uniques |
| Interactions | `total_interactions` | |
| J'aime, enregistrements, commentaires, partages, republications, réponses aux stories | `likes`, `saves`, `comments`, `shares`, `reposts`, `replies` | |
| Comptes ayant interagi | `accounts_engaged` | comptes uniques |
| Appuis sur les boutons du profil / sur l'adresse | `profile_links_taps` + `breakdown=contact_button_type` | adresse = `DIRECTION` ; aussi CALL, EMAIL, TEXT, BOOK_NOW |
| Abonnements, désabonnements, nouveaux followers nets | `follows_and_unfollows` + `breakdown=follow_type` | net = abonnements − désabonnements |
| Mini-graphiques | `reach` (`time_series`, par jour), `follower_count` (30 derniers jours) | seules séries temporelles disponibles |
| Audience : âge, genre, pays, villes | `follower_demographics` et `engaged_audience_demographics` (`period=lifetime`, `timeframe`, `breakdown=age/gender/country/city`) | top 45 ; 100 followers (ou 100 interactions) minimum |
| Heures d'activité des followers | `online_followers` | 30 derniers jours ; 100 followers minimum |

Limites : plages `since`/`until` découpées en tranches de 30 jours ; sur **90 jours**, les métriques additives sont sommées par tranche mais les **comptes uniques** (`reach`, `accounts_engaged`) ne peuvent pas l'être et ne sont pas affichés (note dans la page). Sous **100 followers**, la section Audience affiche seulement un message expliquant que Meta ne fournit pas ces données. Données avec jusqu'à 48 h de retard.

**Non disponibles via l'API (omis du dashboard)** : sources des vues (« Depuis la page d'accueil », « Depuis le profil », « Autre ») ; répartition followers / non-followers des **interactions** (`total_interactions` et `accounts_engaged` n'ont pas de breakdown `follow_type`) ; **activité du profil** et **visites du profil** au niveau du compte (`profile_views` supprimée le 08/01/2025) ; **appuis sur les liens externes** (`website_clicks` supprimée le 08/01/2025 ; le clic sur le lien en bio n'existe que par publication via `profile_activity`) ; `impressions` (supprimée le 21/04/2025) ; jours d'activité des followers (seulement les heures) ; `reached_audience_demographics` (plus listée).

---

## 4. TikTok

Doc : <https://developers.tiktok.com/doc/login-kit-web> et <https://developers.tiktok.com/doc/display-api-get-started>

1. <https://developers.tiktok.com/> → **Manage apps** → **Connect an app / Create app** (compte développeur requis).
2. Renseignez : icône (le logo convient), catégorie, description, **Terms of Service URL** = `https://dashboard.birostweb.fr/conditions` et **Privacy Policy URL** = `https://dashboard.birostweb.fr/confidentialite`, plateforme **Web**, site `https://dashboard.birostweb.fr`.
3. Ajoutez les produits **Login Kit** et **Display API**. Redirect URI (Web) : `https://dashboard.birostweb.fr/api/auth/tiktok/callback`.
4. Scopes : `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`.
5. **Sandbox** : créez un sandbox, ajoutez votre compte TikTok comme *Target user* : vous pouvez tester immédiatement. Pour la production : **Submit for review** (quelques jours, vidéo de démonstration demandée).
6. **Client key** → `TIKTOK_CLIENT_KEY`, **Client secret** → `TIKTOK_CLIENT_SECRET`.

Tokens : access token **24 h**, rafraîchi automatiquement (refresh token valable 365 jours).

---

## 5. Connecter les comptes dans le dashboard
1. Ouvrez `https://dashboard.birostweb.fr`, saisissez `DASHBOARD_PASSWORD`.
2. Navigation **Réseaux sociaux** → choisir Instagram ou TikTok, puis **Connecter**. LinkedIn reste en attente tant que son accès n’est pas approuvé (§2).
3. Autorisez sur la plateforme ; vous revenez sur la page de la plateforme avec « Compte … connecté ».
4. « Déconnecter » révoque le token quand la plateforme le permet, puis supprime du serveur le token, l'historique des abonnés et le cache de cette plateforme.

### Vérifications
- Barre latérale : état connecté, déconnecté, en attente d’approbation ou en erreur ; aucune donnée de démonstration.
- `https://dashboard.birostweb.fr/api/status` (une fois connecté) : `status`, `expiresAt`, `notes` par plateforme. Aucun token n'y figure.
- Logs Dokploy du service `api` : `compte connecté`, `token rafraîchi`, et les erreurs éventuelles (sans secrets).

---

### 5.1 Ce que le dashboard récupère, par plateforme

Les routes `GET /api/platforms/:platform/stats`, `GET /api/posts`, `GET /api/overview` et `GET /api/status` (session obligatoire) exposent les données ci-dessous. Une donnée inconnue vaut toujours `null` (jamais 0). Les `details` sont filtrés par liste blanche : aucun jeton, refresh token, `state` ou clé n'est jamais renvoyé.

**TikTok** (Display API, scopes `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`)

| Donnée | Champ exposé | Remarque |
|---|---|---|
| Profil | `details.profile` (nom, @, bio, vérifié, avatar, abonnés, abonnements, j'aime totaux, nombre de vidéos) | Avatar : URL de CDN qui expire |
| Cadence | `details.cadence` (publications par semaine, dernière publication) | Moyenne sur la fenêtre réellement couverte |
| Couverture | `coverage` (vidéos lues, fenêtre 190 j, pages max, tronqué) | |
| Publications | vues, j'aime, commentaires (nombre), partages, durée, tranche de durée, couverture, lien | `saves` = `null` (non fourni) |

**Instagram** (Instagram API with Instagram Login, scopes `instagram_business_basic`, `instagram_business_manage_insights`, `instagram_business_manage_comments`)

| Donnée | Champ exposé | Remarque |
|---|---|---|
| Profil | `details.profile` (identifiant, nom, type de compte, bio, site, photo, abonnés, abonnements, médias) | Bio, site, photo et abonnements peuvent être omis par Meta (noté dans `notes`) |
| Reels | `details.reels` (nombre mesuré, temps de visionnage moyen et total, taux de sortie) | Moyennes pondérées par les vues, Reels mesurés uniquement |
| Couverture | `coverage` (médias lus, insights lus, commentaires lus, tronqué, fenêtre 190 j) | Plafonds : `INSTAGRAM_INSIGHT_MEDIA_MAX`, `INSTAGRAM_COMMENT_MEDIA_MAX` |
| Publications | portée (`reach`), vues réelles (`viewsCount`), enregistrements, partages, reposts, interactions totales, visites de profil, abonnements gagnés, vignette, type de produit | `views` reste la portée héritée (`reach` sinon vues) |
| Compte | `GET /api/platforms/instagram/insights` (vues, interactions, profil, audience) | Voir §3.1 |

**LinkedIn** (Community Management API ; `rw_organization_admin`, `r_organization_social`, `r_organization_social_feed` si accordé)

| Bloc (`details.blocks.*`) | Scope | Contenu |
|---|---|---|
| `organization` | `rw_organization_admin` | Nom, vanity, site, description, taille, secteurs, création, type |
| `followers` | `rw_organization_admin` | Total, gains quotidiens (organique / payant), facettes (top 100) |
| `pageStats` | `rw_organization_admin` | Vues de Page et visiteurs uniques par jour, par section, par appareil, clics |
| `posts` | `r_organization_social` | Publications organiques (les sponsorisées sont listées à part, exclues des agrégats) |
| `postStats` | `rw_organization_admin` | Impressions, impressions uniques, clics, réactions, commentaires, partages, taux d'engagement |
| `dailyImpressions` | `rw_organization_admin` | Impressions quotidiennes de la Page |
| `reactions`, `comments` | `r_organization_social_feed` | Réactions par type, commentaires |

Chaque bloc porte un état `ok`, `scope_missing`, `not_available` ou `budget_exhausted` avec une raison. `details.budget` indique les appels du jour (`used` / `limit`, `resetsAt`). Les facettes (pays, fonction, séniorité, secteur, taille, région) sont renvoyées sous forme d'URN **non résolus** : aucun libellé n'est inventé.

### 5.2 Limites connues par plateforme
- **TikTok** : pas de commentaires (nombre seulement), pas de démographie de l'audience, pas de vues par jour, pas d'enregistrements. Avatar et couvertures sont des URL signées qui expirent.
- **Instagram** : démographie et gains/pertes d'abonnés réservés aux comptes de 100 abonnés ou plus ; démographie limitée aux 45 premières valeurs par découpage ; stories non collectées ; les insights sont lus pour 120 publications au plus (`INSTAGRAM_INSIGHT_MEDIA_MAX`), les commentaires pour 30 (`INSTAGRAM_COMMENT_MEDIA_MAX`) : la couverture partielle est signalée dans `coverage` et `notes`. Comptes uniques indisponibles sur 90 jours.
- **LinkedIn** : aucune donnée avant l'approbation de Community Management API ; quota du niveau Development de 100 appels par jour et par membre (budget interne de 80, remis à zéro à 00:00 UTC, compteur en mémoire donc remis à zéro à chaque redémarrage du service) ; statistiques de followers et de Page disponibles avec un décalage de J-2 ; 12 mois d'historique ; les commentaires de membres ne sont jamais conservés plus de **48 h** (cache plafonné, rien n'est écrit dans `store.enc.json` à part les jetons et les instantanés de followers) ; auteurs affichés « Membre LinkedIn ».
- **Images** : seules les URL `https` de CDN connus sont relayées (`cdninstagram.com`, `fbcdn.net`, `fbsbx.com`, `tiktokcdn.com`, `tiktokcdn-us.com`, `tiktokcdn-eu.com`, `ibytedtos.com`, `tiktok.com`, `licdn.com`), sans identifiants ni fragment ; sinon `imageUrl` vaut `null`. Ces URL **expirent** : elles ne sont jamais stockées, et l'interface doit prévoir un repli quand l'image ne se charge plus. La directive `img-src` du CSP de `nginx.conf` contient exactement les mêmes suffixes (en `https://*.suffixe`) ; aucune autre directive n'a été élargie.

### 5.3 Nouvelles variables d'environnement
Toutes optionnelles (valeur par défaut entre parenthèses ; une valeur invalide revient au défaut, une valeur hors bornes est ramenée dans les bornes). Voir `.env.example`.

| Variable | Défaut | Rôle |
|---|---|---|
| `INSTAGRAM_INSIGHT_MEDIA_MAX` | 120 (1 à 500) | Publications dont les insights sont lus |
| `INSTAGRAM_COMMENT_MEDIA_MAX` | 30 (0 à 200) | Publications dont les commentaires sont lus |
| `INSTAGRAM_INSIGHT_CONCURRENCY` | 5 (1 à 10) | Appels d'insights simultanés |
| `TIKTOK_RETRY_DELAY_MS` | 500 (0 à 10000) | Délai de base avant nouvelle tentative (doublé à chaque essai) |
| `LINKEDIN_DAILY_CALL_BUDGET` | 80 (0 à 100) | Budget d'appels LinkedIn par jour UTC |
| `LINKEDIN_PRIORITY_RESERVE` | un tiers du budget, 25 au plus | Réserve : le détail réactions/commentaires s'arrête avant |
| `LINKEDIN_MAX_POST_PAGES` | 5 (1 à 20) | Pages de publications (50 par page) |
| `LINKEDIN_PAGE_STATS_DAYS` | 90 (1 à 365) | Fenêtre des statistiques de Page |
| `LINKEDIN_PAGE_STATS_GRANULARITY` | `DAY` | `DAY` ou `MONTH` |
| `LINKEDIN_REACTIONS_MAX_POSTS` | 15 (0 à 100) | Publications dont on lit les réactions par type |
| `LINKEDIN_COMMENTS_MAX_POSTS` | 15 (0 à 100) | Publications dont on lit les commentaires |
| `LINKEDIN_SHARE_STATS_LIST_STYLE` | `list` | `list` ou `indexed` (repli si LinkedIn répond 400) |
| `LINKEDIN_CACHE_TTL_SECONDS` | 43200 (60 à 172800) | Cache LinkedIn dédié, plafonné à 48 h (commentaires) |
| `LINKEDIN_REFRESH_INTERVAL_HOURS` | 12 (1 à 168) | Intervalle minimal entre deux relectures automatiques LinkedIn |

**Budget LinkedIn et rafraîchissement automatique.** Avec `REFRESH_INTERVAL_HOURS=6`, le service tourne 4 fois par jour, mais LinkedIn n'est relu qu'au plus toutes les 12 h (2 relevés par jour) afin de rester sous le budget de 80 appels : un relevé complet peut coûter plusieurs dizaines d'appels (publications, statistiques par lot, 1 appel par publication pour réactions et commentaires). Une visite du dashboard ne relit LinkedIn que si le cache de 12 h a expiré. L'actualisation manuelle ne contourne pas le budget : si le budget connu est épuisé, aucun appel n'est fait et la réponse l'indique ; si la relecture est amputée par le budget, les données complètes précédentes sont conservées.

### 5.4 Actualisation manuelle
`POST /api/platforms/:platform/refresh` (session et même origine obligatoires, corps JSON `{}`) invalide le cache de la plateforme et la relit. Limites : 6 actualisations par minute et par session, et 60 s minimum entre deux actualisations d'une même plateforme (HTTP 429 avec `Retry-After`). La réponse contient le statut (`refreshed` ou `budget_exhausted`), `refreshed`, `updatedAt` (horodatage de la dernière lecture réelle) et, pour LinkedIn, le budget.

### 5.5 Taux d'engagement
Tous les taux par publication sont exprimés en **pourcentage**, `null` si l'audience est inconnue :
- **Instagram** : (j'aime + commentaires + partages + enregistrements si connus) ÷ **portée** × 100.
- **TikTok** : (j'aime + commentaires + partages) ÷ **vues** × 100 (pas d'enregistrements).
- **LinkedIn** : taux fourni par l'API (clics + réactions + commentaires + partages ÷ impressions), converti en pourcentage ; `null` si la publication n'est pas mesurée.
- **Taux global** (`/api/overview`, `totals.engagementRate`) : total des interactions ÷ total des audiences des publications de la période (portée Instagram, vues TikTok, impressions LinkedIn) × 100. Seules les publications d'audience connue sont comptées. Sa variation est un écart en **points**.

Les variations de `/api/overview` (`totals`, `kpisByPlatform`) comparent la période courante à la précédente de même durée ; sans historique suffisant (premier relevé trop récent, collecte plus courte que deux périodes, collecte tronquée), `previous` et `delta` valent `null` et `reason` l'explique.

### 5.6 À valider sur un vrai compte
- **TikTok** : champs `bio_description`, `is_verified`, `likes_count`, `video_count` selon les scopes accordés ; présence de `cover_image_url` via `video/query` ; nouveau `refresh_token` et `refresh_expires_in` renvoyés à chaque rafraîchissement (le dashboard enregistre l'objet complet) ; comportement du délai de nouvelle tentative sous limite de débit.
- **Instagram** : champs de profil étendus (`biography`, `website`, `profile_picture_url`, `follows_count`) ; métriques de publication par type de média (`views`, `reach`, `reposts`, `profile_visits`, `follows`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`, `reels_skip_rate`) et compteurs de médias refusés ; unité des temps de visionnage (millisecondes supposées) ; concurrence de 5 appels sans limite de débit ; durée de validité des URL de vignettes.
- **LinkedIn** : approbation de Community Management API et scopes réellement visibles ; format de la liste d'identifiants des statistiques par publication (`list` ou `indexed`) ; noms des facettes de followers et de Page et forme des URN ; granularité `DAY` des statistiques de Page ; champs d'organisation réservés aux administrateurs ; `engagement` en ratio ; consommation réelle d'appels par relevé complet (réglage du budget et de la réserve) ; `likeCount` négatif ; détection des publications sponsorisées ; scope `r_organization_social_feed` et rétention de 48 h.
- **Jetons** : texte exact de la réponse d'Instagram à un rafraîchissement trop précoce (détecté par statut 400 et le motif « 24 hours » / « at least » ; sinon traité comme refus) ; `invalid_grant` de TikTok (HTTP 400 ou 200) ; durée réelle du refresh token TikTok.
- **Dashboard** : chargement des images depuis les CDN avec le CSP, expiration des URL (repli), rafraîchissement manuel sur un vrai compte, échéances des jetons affichées dans la page Paramètres (`/api/status` : `expiresAt`, `refreshExpiresAt`).

## 5bis. Jetons : durées, renouvellement, reconnexion

| Réseau | Jeton d'accès | Renouvellement | Quand reconnecter |
|---|---|---|---|
| TikTok | 24 h | **Automatique** : dès qu'il reste moins d'1 h ; le refresh token (365 j) est renouvelé et persisté à chaque fois | Seulement avant l'échéance du refresh token (date « reconnexion nécessaire avant le… »), ou si TikTok le révoque |
| Instagram | Jeton long 60 j | **Automatique** : dès qu'il reste moins de 7 j et que le jeton a au moins 24 h | Si le renouvellement échoue durablement, ou après expiration |
| LinkedIn | 60 j | Aucun renouvellement programmatique pour la plupart des apps (reconnexion manuelle) | Avant l'échéance (alerte dès 14 j) |

L'expiration du jeton d'ACCÈS TikTok (24 h) n'est jamais une échéance pour l'utilisateur : le bouton « Actualiser » ne touche que les données, jamais le jeton.

**Renouvellement automatique** : toutes les 15 minutes, même sans utilisateur (indépendant de `REFRESH_INTERVAL_HOURS`), puis à chaque lecture de données. Un échec est mémorisé (message générique, sans secret) ; la tentative suivante est espacée (15 min, puis 30 min, 1 h… plafonné à 6 h ; 6 h après un refus définitif). Un succès efface l'erreur. Les métadonnées (`lastRenewedAt`, erreur, prochaine tentative) sont stockées dans le store chiffré, jamais de jeton. Une nouvelle connexion ou une déconnexion les remet à zéro.

**Renouvellement manuel** : `POST /api/platforms/:platform/token/refresh` (session, origine, JSON `{}`). Au moins 30 s entre deux renouvellements d'une même plateforme, 6 par minute et par session.
- `200` `{ok, platform, renewed:true, expiresAt, refreshExpiresAt, renewedAt, message}`
- `409` : `not_connected`, `pending_approval`, `not_refreshable` (reconnectPath), `reconnect_required` (refresh token expiré ou refusé ; reconnectPath), `too_soon` (Instagram, moins de 24 h ; `eligibleAt`, `retryAfter`)
- `429` : `refresh_too_soon` (30 s) ou `too_many_requests` (6/min) ; `502` : `upstream` (erreur réseau/5xx du fournisseur, sans demande de reconnexion)

**`/api/status` > `platforms.<réseau>.token`** : `kind` (`auto` | `manual`), `autoRenew`, `accessExpiresAt`, `refreshExpiresAt`, `lastRenewedAt`, `lastRenewError`, `health`, `reconnectBy`, `reconnectPath`, `note`.

| `health` | Signification |
|---|---|
| `ok` | Rien à faire (TikTok : refresh token à plus de 30 j ; Instagram : échéance à plus de 7 j ; LinkedIn : plus de 14 j) |
| `renewing` | Instagram : échéance < 7 j, renouvellement automatique en cours ou possible ; TikTok : jeton d'accès expiré, nouvelle tentative prévue |
| `reconnect_soon` | Reconnexion à prévoir avant `reconnectBy` (TikTok : refresh token < 30 j ; Instagram : < 7 j ET dernier renouvellement en échec ; LinkedIn : < 14 j) |
| `reconnect_required` | Jeton expiré ou renouvellement refusé définitivement : utiliser `reconnectPath` |
| `not_connected` / `pending` | Compte non connecté / LinkedIn en attente d'approbation |

---

## 6. Limites connues
- **Commentaires TikTok** : non disponibles (la Display API ne fournit que leur nombre ; la Research API est réservée aux chercheurs). Le dashboard l'indique dans la vue Commentaires.
- **LinkedIn** : rien avant l'approbation de Community Management API (état « en attente ») ; commentaires uniquement avec `r_organization_social_feed` ; les auteurs des commentaires s'affichent « Membre LinkedIn » (la lecture des profils des membres n'est pas demandée).
- **Historique** : les API donnent des totaux par publication, pas d'historique complet. Les j'aime, commentaires et partages sont rattachés au **jour de publication** ; les vues quotidiennes viennent des insights du compte quand ils existent (Instagram, LinkedIn). Les abonnés sont relevés chaque jour (toutes les 6 h) : les courbes s'enrichissent avec le temps.
- **Sentiment** : estimé par des règles simples de mots-clés (aucune API ne le fournit).
- **Quotas** : cache mémoire de 15 min (`CACHE_TTL_SECONDS`, 12 h pour LinkedIn : `LINKEDIN_CACHE_TTL_SECONDS`) ; une plateforme en erreur n'est pas rappelée pendant 1 min.

## 7. Dépannage
| Symptôme | Cause probable / solution |
|---|---|
| `redirect_uri mismatch` / « The redirect_uri does not match » | L'URL déclarée diffère de `PUBLIC_URL` + `/api/auth/<plateforme>/callback` (http au lieu de https, `/` final, `www`). Corrigez côté portail **ou** `PUBLIC_URL`, puis redéployez. |
| Retour avec « requête expirée ou invalide » | State OAuth expiré (10 min) ou cookies bloqués : recommencez depuis le dashboard, dans le même navigateur. |
| « identifiants de l'application absents » | Variables `*_CLIENT_ID` / `*_SECRET` vides dans Dokploy. |
| « échange du code refusé » | Mauvais secret, code déjà utilisé, ou redirect URI différente entre l'autorisation et l'échange. |
| LinkedIn `unauthorized_scope_error` | Un scope de `LINKEDIN_SCOPES` n'est pas listé dans l'onglet Auth : retirez-le (voir §2.2 et §2.5). |
| « En attente d'approbation LinkedIn » alors que c'est approuvé | `LINKEDIN_COMMUNITY_API` encore à `false`, ou 403 sur les endpoints organisation : voir `/api/debug/linkedin`. |
| LinkedIn 403 sur les statistiques | Community Management API non accordée, Page non vérifiée, ou compte non administrateur (voir `/api/debug/linkedin`). |
| Instagram « Insufficient developer role » | Compte Instagram non ajouté comme testeur, ou invitation non acceptée. |
| API ne démarre pas (`Configuration invalide`), `/api/*` en 502, conteneur `api` « restarting » | Secrets absents, trop courts (mot de passe tronqué par ` #` ou `$`, voir §1.4) ou valeurs d'exemple : les logs du service `api` listent les variables en cause (jamais leurs valeurs). |
| « n'est pas inscriptible par l'utilisateur uid 1000 » | Volume `api-data` appartenant à root : le service ponctuel `api-init` corrige les droits à chaque déploiement ; vérifiez qu'il s'est terminé en « exited (0) ». |
| « Impossible de déchiffrer le stockage des tokens » | `TOKEN_ENCRYPTION_KEY` a changé : remettez l'ancienne, ou supprimez le volume `api-data` et reconnectez. |
| 429 sur la connexion | 5 échecs en 15 min depuis la même IP : patientez. Au-delà de `LOGIN_GLOBAL_MAX` échecs toutes IP confondues (500 par défaut), seuls les appareils jamais connectés sont bloqués ; un navigateur déjà connecté (cookie `sd_device`) reste autorisé. |
| « Origine non autorisée : ouvrez le dashboard depuis … » | L'adresse ouverte dans le navigateur diffère de `PUBLIC_URL` (www, autre domaine, http) : utilisez exactement `PUBLIC_URL`. |
| Déconnecté après un Redeploy | Normal : les sessions sont gardées en mémoire et révoquées à chaque redémarrage de l'API. |

## 8. Sécurité
- Ne commitez **jamais** `.env` ; il est exclu des images Docker (`.dockerignore`), vérifié à la construction.
- **Rotation** : `SESSION_SECRET` (déconnecte toutes les sessions), `DASHBOARD_PASSWORD` (sans effet sur les tokens), secrets d'app (régénérez-les dans le portail puis mettez à jour Dokploy). Pour changer `TOKEN_ENCRYPTION_KEY`, supprimez le volume et reconnectez les comptes.
- L'API n'est pas exposée : seul `web` a un domaine. CORS fermé, requêtes modifiantes limitées à la même origine, cookies `HttpOnly` + `Secure` + `SameSite=Lax`, anti brute-force, comparaison du mot de passe en temps constant.
- Journaux sans paramètres d'URL (pas de code OAuth) ni tokens, limités à environ 30 Mo par service.
- **Sessions révocables** : l'identifiant de session est enregistré en mémoire côté serveur ; « Se déconnecter » le révoque (une copie du cookie devient inutilisable), « Déconnecter toutes les sessions » (Paramètres) les révoque toutes, et tout redémarrage de l'API (rotation de `SESSION_SECRET`/`DASHBOARD_PASSWORD` + Redeploy) aussi. Durée maximale : `SESSION_TTL_HOURS` (1 à 24 h).
- **Pas de double authentification (2FA)** : la connexion se fait par mot de passe seul (`DASHBOARD_PASSWORD`), protégée par la limitation de tentatives (5 échecs par 15 min et par IP). Choisissez un mot de passe long (phrase de passe de 20 caractères ou plus). Si une ancienne variable `DASHBOARD_TOTP_SECRET` reste définie dans Dokploy, elle est ignorée : vous pouvez la supprimer.
- **Mot de passe compromis ?** `cd backend && DASHBOARD_PASSWORD='…' npm run check-password` (Have I Been Pwned en k-anonymity : seuls 5 caractères du SHA-1 partent sur le réseau ; rien n'est affiché).
- **Conteneurs** : `web` (nginx) tourne en utilisateur non-root, racine en lecture seule, sans capacité ; `api-init` n'a ni réseau ni `DAC_OVERRIDE` ; limites mémoire/CPU/processus dans `docker-compose.yml` (à ajuster d'après `docker stats`).

## 9. Ce qui n'a pas été vérifié
Aucun appel réel n'a été fait aux API TikTok, Meta ou LinkedIn (pas d'identifiants disponibles). Les points à surveiller au premier branchement : noms exacts des champs dans les portails ; disponibilité des métriques Instagram (`views`, `reach`, `follower_count`, `reposts`, `online_followers`, valeurs `timeframe` acceptées pour la démographie, sens exact de `follow_type` sur `follows_and_unfollows`, fuseau des heures de `online_followers`), que Meta modifie régulièrement (§3.1) ; scopes réellement accordés au Development Tier et scope exact de `networkSizes` (§2.2) ; OAuth LinkedIn réel (impossible avant approbation) ; exigence d'une page de CGU par TikTok ; libellés Dokploy (Compose, Domains, rattachement à `dokploy-network`).


## 10. Mode en direct (données quasi instantanées tant que l'application est ouverte)

### 10.1 Comment ça marche

**Présence.** Le backend considère l'application « utilisée » dès qu'il reçoit une requête authentifiée vers une route de données (`/api/overview`, `/api/platforms/*`, `/api/posts`, `/api/comments`, `/api/status`…) ou un battement `POST /api/live/ping` (session et même origine obligatoires, corps JSON `{}`, réponse 204) dans les `LIVE_ACTIVE_WINDOW_SECONDS` dernières secondes (90 par défaut). Passé ce délai sans requête, tout est en pause : l'API n'appelle plus TikTok ni Instagram. Le premier battement suivant reprend immédiatement.

**Deux paliers par plateforme (Instagram et TikTok uniquement).**

| Palier | Instagram | TikTok |
|---|---|---|
| Léger (rapide) | profil et compteurs, liste des médias récents, portée quotidienne récente et totaux des dernières 24 h : 4 appels en parallèle toutes les 60 s | profil + première page de vidéos (compteurs récents) : 2 appels toutes les 90 s |
| Lourd (complet) | insights par publication, audience, commentaires, historique complet (+ insights de compte des périodes consultées) toutes les 15 min, ou au clic sur Actualiser | pagination complète, miniatures manquantes, couverture et cadence toutes les 15 min |

Le palier léger fusionne dans le même jeu de données : il met à jour les compteurs sans écraser ce que le palier lourd a apporté (insights par publication, détails, commentaires, publications plus anciennes). `heavyUpdatedAt` indique l'âge du dernier palier lourd, `updatedAt` celui de la dernière lecture réelle (n'importe quel palier). Les paliers ne tournent que pour une plateforme connectée, jamais en attente d'approbation ni avec un jeton expiré, s'arrêtent dès que la présence tombe, un cycle à la fois par plateforme, avec une variation aléatoire de ±10 %. En cas d'erreur ou de limite (429), le délai double (plafonné à 15 min). Pour Instagram, si Meta renvoie des en-têtes de quota (`X-App-Usage`, `X-Business-Use-Case-Usage`) au-delà de 70 %, la cadence est divisée par deux (par quatre au-delà de 90 %).

**LinkedIn n'est jamais accéléré.** Aucun palier, aucun sondage : même cadencement qu'avant (cache de 12 h, relecture au plus toutes les 12 h) plus l'actualisation manuelle bornée par le budget (voir §5.3 et §5.4).

**Réponse immédiate (stale-while-revalidate).** `/api/overview`, `/api/platforms/:p/stats`, `/api/platforms/:p/insights`, `/api/posts`, `/api/comments` et `/api/status` n'attendent jamais le fournisseur quand une donnée existe, même périmée : la réponse est immédiate, la revalidation part en arrière-plan (une seule à la fois par plateforme et par palier). Champs ajoutés : `updatedAt`, `stale` (donnée plus vieille que le cache), `refreshing` (une lecture est en cours), `loading` (blocs encore en chargement) et `heavyUpdatedAt`. `/api/posts` reste un tableau : ces informations sont dans les en-têtes `X-Data-Updated-At`, `X-Data-Stale`, `X-Data-Refreshing`, `X-Data-Loading`. Premier chargement sans aucun cache : réponse partielle rapide avec le palier léger, `loading` liste les blocs en cours (Instagram : `post_insights`, `comments`, `audience` ; TikTok : `video_history`, `thumbnails`) et le palier lourd complète en arrière-plan. **Démarrage à froid (aucun cache).** Le palier léger passe TOUJOURS en premier et indépendamment du lourd : le single-flight est PAR PALIER, une requête de données ne rejoint jamais un palier lourd en vol. La première réponse revient donc dès la fin du léger (quelques centaines de ms, jamais la durée du lourd) avec `refreshing: true` et `loading` renseigné ; le lourd démarre juste après le léger (jamais en parallèle sur le même quota) puis les réponses suivantes se complètent par fusion, sans écraser. Si le léger échoue au démarrage, le backoff habituel s'applique et le lourd n'est pas lancé tant que le léger n'a jamais réussi (aucun quota gaspillé ; l'actualisation manuelle reste directe). Avec un cache restauré, la réponse est immédiate (`stale: true`) et la revalidation légère part avant la lourde. **Insights Instagram (`/insights`) sans cache** : si le palier lourd n'a pas fini, la route répond immédiatement, sans appeler Meta, avec `loading: ["account_insights", "audience"]`, `refreshing: true`, `updatedAt: null`, `stale: false`, `views`, `interactions`, `profile`, `audience` à `null` (jamais 0), `errors: {}`, `notes: []`, et la série quotidienne `series` habituelle ; le palier lourd lit ensuite les insights et la requête suivante les trouve en cache (les champs existants gardent leur forme). Une fois le lourd terminé, un insight sans cache est lu normalement (une seule fois). En cas d'erreur réseau pendant une revalidation, la donnée périmée reste affichée (`refreshError`) ; une erreur d'authentification fait passer la plateforme en « expiré ».

**Cache persistant.** Le dernier jeu de données valide est écrit dans `DATA_DIR/cache.enc.json` (fichier distinct de `store.enc.json`), chiffré AES-256-GCM avec `TOKEN_ENCRYPTION_KEY`, écriture atomique, mode 0600, version de schéma, 6 Mo maximum. Il est rechargé au démarrage : le premier affichage après un redémarrage est instantané et ne coûte aucun appel tant que les données ont moins de 15 min. **Jamais persistés** : commentaires (texte et auteurs), jetons, états OAuth, URL d'images signées (elles expirent), et pour LinkedIn tout ce qui touche à l'activité de membres (publications et réactions, détails) : seules les statistiques de Page et le nombre de followers sont écrits. Le cache d'une plateforme déconnectée est purgé à la déconnexion et au démarrage. Un fichier absent, corrompu, d'une autre clé ou d'un autre schéma est simplement ignoré. Après un redémarrage, les commentaires Instagram reviennent avec le premier palier lourd (`loading: ["comments"]`).

**Ce qui continue sans utilisateur (essentiel et léger).** (1) Le rafraîchissement des jetons avant expiration. (2) L'instantané quotidien de followers : au plus un appel léger par plateforme et par jour (1 appel `user/info` TikTok, 1 appel `me?fields=followers_count` Instagram), uniquement si aucun instantané n'a encore été pris ce jour-là, sans perte d'historique ; LinkedIn garde une lecture budgétée au plus une fois par jour dans ce cas. Cette maintenance tourne toutes les `REFRESH_INTERVAL_HOURS` heures. Avec `LIVE_ENABLED=false`, l'ancien comportement revient : relecture complète périodique, aucune pause automatique.

**Transport.** Tous les appels fournisseurs partagent des connexions persistantes (keep-alive, pipelining désactivé, 16 connexions par origine au plus). Les appels indépendants sont parallélisés (profil, médias, portée quotidienne, insights par média, commentaires). Les routes de données renvoient un en-tête `Server-Timing` (étapes `auth`, `dataset`, `aggregate`, `insights`, `status`, `total` en ms, sans donnée sensible) et les journaux pino consignent la durée des routes (route sans query, statut, ms ; niveau `warn` au-delà d'1 s, `debug` sinon).

### 10.2 Appels par heure aux valeurs par défaut, comparés aux quotas

Les chiffres sont des plafonds théoriques **pendant que l'application est ouverte**. Application fermée : 0 appel par heure (hors maintenance essentielle). Le compteur réel des 60 dernières minutes est exposé par plateforme dans `GET /api/status` (`callsLastHour`, `quota`).

| Plateforme | Léger | Lourd | Total max/h (ouvert) | Quota fournisseur | Marge |
|---|---|---|---|---|---|
| Instagram | 4 appels/min = 240/h | 4 cycles/h × au plus ~165 appels (1 profil x3, 5 pages de médias, 120 insights par média, 6 fenêtres de portée, 1 gain de followers, 30 lectures de commentaires) = au plus 660/h ; insights de compte de la période 30 j : ~35 appels × 4 = ~140/h (jusqu'à ~450/h si 3 périodes sont consultées) | ~1 050/h typique, ~1 350/h au pire | Meta : 4800 × impressions du compte par 24 h et par app+utilisateur. Même avec 100 impressions/jour : 480 000 appels/jour ≈ 20 000/h | au pire ~7 % du quota d'un compte minuscule, très peu pour un compte réel ; ralentissement automatique à 70 % si les en-têtes sont présents |
| TikTok | 2 appels / 90 s = 80/h | 4 cycles/h × au plus ~21 appels (1 profil, 10 pages, miniatures par lots de 20) = au plus 84/h | ~165/h ≈ 2,7 appels/min | Display API : 600 requêtes/min par endpoint | < 0,5 % ; backoff exponentiel sur 429 |
| LinkedIn | aucun | aucun (jamais accéléré) | 0 en direct ; 2 relevés par jour au plus (cadencement inchangé) | Development tier : 100 appels/jour/membre ; budget interne 80 | inchangé (budget 80 / 100) |

Un premier chargement sans cache enchaîne un palier léger puis un palier lourd, soit un appel de profil de plus qu'avant (TikTok : `user/info` appelé deux fois).

### 10.3 Variables (toutes optionnelles ; valeur invalide → défaut, hors bornes → ramenée dans les bornes)

| Variable | Défaut | Bornes | Rôle |
|---|---|---|---|
| `LIVE_ENABLED` | `true` | | Mode en direct (paliers automatiques et pause sans utilisateur) |
| `LIVE_ACTIVE_WINDOW_SECONDS` | 90 | 30 à 900 | Durée pendant laquelle une requête ou un battement vaut « application utilisée » |
| `LIVE_INSTAGRAM_LIGHT_SECONDS` | 60 | 15 à 3600 | Palier léger Instagram |
| `LIVE_INSTAGRAM_HEAVY_SECONDS` | 900 | 60 à 86400 (jamais sous le léger) | Palier lourd Instagram |
| `LIVE_TIKTOK_LIGHT_SECONDS` | 90 | 15 à 3600 | Palier léger TikTok |
| `LIVE_TIKTOK_HEAVY_SECONDS` | 900 | 60 à 86400 (jamais sous le léger) | Palier lourd TikTok |
| `PERSIST_CACHE` | `true` | | Écrit et recharge `cache.enc.json` |

Les planchers (15 s léger, 60 s lourd) empêchent de dépasser un quota par erreur de configuration.

### 10.4 Limites honnêtes

- « Instantané » signifie ici : affichage immédiat du cache et rafraîchissement continu en arrière-plan tant que l'application est ouverte. Ce n'est pas du temps réel au sens strict.
- Les données de Meta et de TikTok ont leur propre latence : les insights Instagram peuvent être en retard de plusieurs heures, jusqu'à 48 h pour certains ; les compteurs de vidéos TikTok (vues, J'aime) ne sont pas mis à jour à la seconde côté TikTok. Lire plus souvent ne les rend pas plus frais que la source.
- Instagram : les compteurs de profil et de médias se rafraîchissent chaque minute, mais portée, vues par publication, audience et commentaires attendent le palier lourd (15 min) ou l'actualisation manuelle.
- LinkedIn reste à son rythme (jamais de direct) ; après un redémarrage ses publications et commentaires reviennent avec la première lecture, car ils ne sont pas persistés.
- Les durées de latence réelles, la consommation de quota constatée (`callsLastHour`, en-têtes `X-App-Usage`) sont à valider sur l'instance réelle.
