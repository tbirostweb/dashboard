# Google Analytics 4 — site birostweb.fr et dashboard

Trois éléments distincts, à ne pas confondre :

| Élément | Où | Rôle |
|---|---|---|
| **Identifiant de mesure** `G-5MVJ5K3QXZ` | Dans le code du **site** birostweb.fr (autre dépôt) | Envoie les visites et événements à GA4 |
| **Identifiant de propriété** (numérique) | Variable `GA4_PROPERTY_ID` du **dashboard** | Permet au dashboard de LIRE les statistiques |
| **Compte de service** (déjà utilisé pour Search Console) | `GSC_CLIENT_EMAIL` / `GSC_PRIVATE_KEY` du dashboard | Autorise la lecture via l'API |

Search Console mesure ce qui se passe **avant** la visite (Google), GA4 et Umami **pendant** la visite. Le dashboard n'enregistre lui-même aucune visite : il lit seulement ces services.

## 1. Installer GA4 sur le site (dépôt birostweb.fr)

À placer UNE seule fois, dans le `<head>` commun à toutes les pages (layout racine). Ne pas ajouter ce script si le site en charge déjà un autre gtag.js.

**Consentement (obligatoire en France / UE)** : GA4 utilise des cookies. Le script ci-dessous démarre en mode « refusé » (Consent Mode v2) : rien n'est stocké tant que le visiteur n'a pas accepté. Branchez votre bandeau de consentement sur `window.gtagConsent(true)`.

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-5MVJ5K3QXZ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' });
  gtag('js', new Date());
  gtag('config', 'G-5MVJ5K3QXZ', { send_page_view: true });
  // À appeler par le bandeau de consentement : gtagConsent(true) après acceptation, gtagConsent(false) après refus.
  window.gtagConsent = function (granted) { gtag('consent', 'update', { analytics_storage: granted ? 'granted' : 'denied' }); };
</script>
```

Site en application monopage (changements de route sans rechargement) : GA4 mesure les changements d'historique automatiquement si « Mesures améliorées > Modifications de page basées sur l'historique du navigateur » est activé (Admin > Flux de données > votre flux). Sinon, envoyez la page vue à chaque changement de route :

```js
gtag('event', 'page_view', { page_location: location.href, page_path: location.pathname, page_title: document.title });
```

### Événements à suivre (clics sortants, devis, contact, formulaires, téléchargements)

```html
<script>
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a,button'); if (!a || typeof gtag !== 'function') return;
    var label = (a.getAttribute('data-track') || a.textContent || '').trim().slice(0, 80);
    var href = a.href || '';
    // Boutons devis / contact : ajoutez data-track="devis" ou data-track="contact" sur les boutons, ou le texte/href sera analysé.
    if (/devis/i.test(label + href))   gtag('event', 'click_devis',   { link_text: label });
    else if (/contact|mailto:|tel:/i.test(label + href)) gtag('event', 'click_contact', { link_text: label });
    // Téléchargements
    if (/\.(pdf|zip|docx?|xlsx?|pptx?)(\?|$)/i.test(href)) gtag('event', 'file_download', { file_name: href.split('/').pop().split('?')[0], link_url: href });
    // Clics sortants
    else if (a.tagName === 'A' && href && a.hostname && a.hostname !== location.hostname && /^https?:/.test(href)) gtag('event', 'click_sortant', { link_url: href, link_domain: a.hostname });
  }, true);
  document.addEventListener('submit', function (e) {
    if (typeof gtag !== 'function') return;
    var f = e.target; gtag('event', 'form_submit', { form_id: f.id || '', form_name: f.getAttribute('name') || f.getAttribute('data-track') || '' });
  }, true);
</script>
```

Dans GA4 > Admin > Événements, marquez `click_devis`, `click_contact` et `form_submit` comme **événements clés** (conversions) si vous voulez les suivre comme objectifs.

## 2. Tester les événements

1. Ouvrez Analytics > **Admin > DebugView** (ou **Rapports > Temps réel**).
2. Sur birostweb.fr, acceptez les cookies, naviguez et cliquez sur un bouton devis / contact : les événements apparaissent en quelques secondes.
3. Pour DebugView, ajoutez `?debug_mode=1` à l'URL ou utilisez l'extension « Google Analytics Debugger ».
4. Les rapports standard (et donc le dashboard) n'affichent les données qu'après 24 à 48 h pour certains rapports ; le Temps réel est immédiat.

## 3. Connecter l'API Analytics au dashboard

1. **Google Cloud** (projet du compte de service) : API et services > Bibliothèque > **Google Analytics Data API** > Activer.
2. **Google Analytics** > Admin > **Gestion des accès à la propriété** > ajouter l'adresse `GSC_CLIENT_EMAIL` (compte de service) avec le rôle **Lecteur**.
3. Relevez l'**ID de propriété** numérique : Admin > **Paramètres de la propriété** (pas l'identifiant `G-…`).
4. Dans Dokploy > service du dashboard > Environment : `GA4_PROPERTY_ID=<identifiant numérique>`. Les variables `GSC_CLIENT_EMAIL` et `GSC_PRIVATE_KEY` existantes sont réutilisées.
5. Redéployez, puis ouvrez **Site web > Google** : la section « Google Analytics » affiche utilisateurs, sessions, pages vues, événements, pages les plus consultées et courbe. Tant qu'aucune visite n'est enregistrée, un message l'explique.

Erreurs fréquentes (le message de l'onglet les nomme) : API non activée dans le bon projet ; compte de service non ajouté à la propriété (« Lecteur ») ; `GA4_PROPERTY_ID` renseigné avec le `G-…` au lieu de l'identifiant numérique.

## 4. Exclure votre propre trafic

- **GA4** : Admin > Flux de données > votre flux > **Configurer les paramètres de balisage > Définir le trafic interne** : créez une règle (nom `proprietaire`, type d'IP « Est égal à » ou plage CIDR). Puis Admin > Paramètres de données > **Filtres de données** : le filtre « Internal Traffic » est créé en mode **Test** ; vérifiez-le dans les rapports, puis passez-le en **Actif**. Une IP à domicile change parfois : mettez à jour la règle.
- **Umami** (service auto-hébergé) : ajoutez la variable `IGNORE_IP=<ip1>,<ip2>` à l'Environment du compose Umami (`docker-compose.umami.yml`), puis redéployez.
- **Search Console** : les clics et impressions ne peuvent **pas** être filtrés par IP (Google ne fournit aucune donnée par visiteur).
- **Le dashboard n'enregistrant aucune visite**, il n'a pas de variable `OWNER_PUBLIC_IPS` : l'exclusion se règle dans GA4 et Umami. Ne comptez jamais sur une IP transmise par le navigateur : seule l'IP vue par le serveur de mesure est fiable.
