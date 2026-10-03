/* =========================================================
   Données FICTIVES — générées de façon déterministe (seed fixe),
   ancrées sur la date du jour. Ne jamais importer ce fichier
   ailleurs que dans js/api.js : c'est la seule source à remplacer
   pour brancher les vraies API.
   ========================================================= */
(function () {
  'use strict';

  const DAYS = 190; // 90 j + 90 j de période précédente + marge

  // PRNG déterministe (mulberry32)
  let seed = 20260930;
  function rand() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const between = (a, b) => a + rand() * (b - a);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const weighted = (entries) => {
    const total = entries.reduce((s, e) => s + e[1], 0);
    let r = rand() * total;
    for (const [v, w] of entries) { if ((r -= w) <= 0) return v; }
    return entries[entries.length - 1][0];
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayStart = new Date(today);
  dayStart.setDate(dayStart.getDate() - (DAYS - 1));
  const iso = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const accounts = {
    tiktok:    { platform: 'tiktok',    name: 'BirostWeb',        handle: '@birostweb',        url: 'https://www.tiktok.com/@birostweb' },
    instagram: { platform: 'instagram', name: 'BirostWeb Studio', handle: '@birostweb.studio', url: 'https://www.instagram.com/birostweb.studio' },
    linkedin:  { platform: 'linkedin',  name: 'BirostWeb',        handle: 'birostweb',         url: 'https://www.linkedin.com/company/birostweb' }
  };

  // Profil de chaque plateforme : volumes, types de posts, heures de publication
  const profiles = {
    tiktok: {
      startFollowers: 41200, perWeek: 4,
      views: [3000, 22000], likeRate: [.05, .09], commentRate: [.004, .009], shareRate: [.006, .018],
      baseViewsPerDay: 1800, followPerView: .0022,
      types: [['Vidéo courte', 5, 1.0], ['Tutoriel', 3, 1.25], ['Coulisses', 2, .9], ['Trend / son', 2, 1.45], ['Live', .6, .7]],
      hours: [[8, 1], [12, 2], [13, 2], [18, 3], [19, 4], [20, 4], [21, 3], [22, 1]]
    },
    instagram: {
      startFollowers: 18900, perWeek: 3,
      views: [3500, 19000], likeRate: [.06, .1], commentRate: [.003, .008], shareRate: [.003, .01],
      baseViewsPerDay: 1500, followPerView: .0016,
      types: [['Reel', 5, 1.3], ['Carrousel', 4, 1.15], ['Photo', 2, .85], ['Story', 2, .6]],
      hours: [[7, 1], [9, 2], [12, 3], [13, 2], [17, 2], [18, 3], [19, 3], [21, 2]]
    },
    linkedin: {
      startFollowers: 5800, perWeek: 2,
      views: [1800, 14000], likeRate: [.03, .055], commentRate: [.003, .008], shareRate: [.002, .006],
      baseViewsPerDay: 420, followPerView: .0028,
      types: [['Texte', 3, .9], ['Image', 3, 1.0], ['Document', 2, 1.35], ['Vidéo', 1.5, 1.1], ['Article', 1, .8]],
      hours: [[7, 2], [8, 4], [9, 3], [12, 2], [13, 1], [17, 2], [18, 1]]
    }
  };
  // Effet de l'heure sur la performance
  const hourBoost = (h) => (h >= 18 && h <= 21) ? 1.2 : (h >= 7 && h <= 9) ? 1.08 : (h >= 12 && h <= 13) ? 1.05 : .9;

  const titles = {
    tiktok: [
      'Refaire un site vitrine en 60 secondes', '3 erreurs qui tuent votre page d\'accueil', 'Avant / après : refonte d\'un site d\'artisan',
      'Pourquoi votre site est lent (et comment le réparer)', 'Une journée dans un studio web', 'Le bouton qui double vos demandes de devis',
      'Mon setup de développeur en 2026', 'Figma → site en ligne : le process', 'On teste la vitesse de 5 sites de boulangeries',
      'Ce que coûte vraiment un site web', 'Animation GSAP en 30 s', 'Les polices à éviter sur votre site',
      'POV : le client veut "un truc qui pète"', 'Hébergement : VPS ou mutualisé ?', 'Le SEO local expliqué simplement',
      'Réaction à vos sites (partie 4)', 'Formulaire de contact anti-spam sans captcha', 'Un site accessible, ça change quoi ?'
    ],
    instagram: [
      'Refonte : restaurant Le Comptoir', 'Palette greige & vermillon — moodboard', '5 principes de mise en page', 'Nouveau projet livré ✦',
      'Coulisses : atelier du mardi', 'Checklist avant de lancer son site', 'Typographie : IBM Plex en action', 'Avant / après : site d\'une kiné',
      'Nos 3 offres expliquées', 'Le process en 4 étapes', 'Mobile first, vraiment', 'Carrousel : les mythes du SEO',
      'Détail d\'interface : les micro-interactions', 'Témoignage client — cabinet d\'architecte', 'Une landing page en 48 h'
    ],
    linkedin: [
      'Ce que 40 refontes nous ont appris sur la conversion', 'Accessibilité numérique : l\'échéance approche pour les PME',
      'Pourquoi nous avons quitté les page builders', 'Étude de cas : +62 % de demandes de devis en 3 mois',
      'Hébergement souverain : notre retour d\'expérience', 'Le vrai coût d\'un site lent pour une TPE',
      'Recrutement : nous cherchons un·e intégrateur·rice', 'Guide PDF : cahier des charges d\'un site vitrine',
      'Core Web Vitals : ce qui compte en 2026', 'Retour sur la conférence Web & PME de Lyon', '5 questions à poser avant de signer un devis web',
      'Maintenance : ce que couvre vraiment un contrat'
    ]
  };

  // ------------ Publications ------------
  const posts = [];
  const daily = {};
  let postSeq = 1;
  Object.keys(profiles).forEach((pf) => {
    const p = profiles[pf];
    // tableaux journaliers
    const views = new Array(DAYS).fill(0), likes = new Array(DAYS).fill(0),
      comments = new Array(DAYS).fill(0), shares = new Array(DAYS).fill(0);

    const prob = p.perWeek / 7;
    for (let d = 0; d < DAYS; d++) {
      if (rand() > prob) continue;
      const type = weighted(p.types.map((t) => [t, t[1]]));
      const hour = weighted(p.hours);
      const growth = 1 + (d / DAYS) * .45; // l'audience progresse
      const viral = rand() < .05 ? between(1.8, 3.2) : 1;
      const mult = type[2] * hourBoost(hour) * growth * viral;
      const v = Math.round(between(p.views[0], p.views[1]) * mult * between(.7, 1.1));
      const l = Math.round(v * between(p.likeRate[0], p.likeRate[1]) * (type[2] > 1.2 ? 1.1 : 1));
      const c = Math.round(v * between(p.commentRate[0], p.commentRate[1]));
      const s = Math.round(v * between(p.shareRate[0], p.shareRate[1]) * (type[0] === 'Document' || type[0] === 'Carrousel' ? 1.6 : 1));
      const date = new Date(dayStart);
      date.setDate(date.getDate() + d);
      date.setHours(hour, Math.floor(rand() * 60), 0, 0);
      // Les stats d'un post se répartissent sur les jours qui suivent la publication
      const decay = [.46, .22, .11, .07, .05, .04, .03, .02];
      const ageMax = DAYS - 1 - d;
      let share = 0;
      decay.forEach((k, i) => { if (i <= ageMax) share += k; });
      const post = {
        id: `${pf.slice(0, 2)}-${String(postSeq++).padStart(4, '0')}`,
        platform: pf,
        type: type[0],
        title: pick(titles[pf]),
        publishedAt: date.toISOString(),
        views: Math.round(v * share), likes: Math.round(l * share), comments: Math.round(c * share), shares: Math.round(s * share),
        saves: pf === 'linkedin' ? 0 : Math.round(l * between(.05, .14) * share)
      };
      if (post.views < 50) continue; // post publié il y a quelques heures
      posts.push(post);
      decay.forEach((k, i) => {
        const di = d + i;
        if (di >= DAYS) return;
        views[di] += v * k; likes[di] += l * k; comments[di] += c * k; shares[di] += s * k;
      });
    }
    // trafic "organique" (anciens contenus, profil) + bruit, week-end plus calme pour LinkedIn
    let followers = p.startFollowers;
    daily[pf] = [];
    for (let d = 0; d < DAYS; d++) {
      const date = new Date(dayStart); date.setDate(date.getDate() + d);
      const dow = date.getDay();
      const weekend = dow === 0 || dow === 6;
      const wk = pf === 'linkedin' ? (weekend ? .45 : 1.1) : (weekend ? 1.12 : 1);
      const base = p.baseViewsPerDay * (1 + d / DAYS * .4) * wk * between(.8, 1.2);
      const dv = Math.round(views[d] + base);
      const dl = Math.round(likes[d] + base * p.likeRate[0] * .8);
      const dc = Math.round(comments[d] + base * p.commentRate[0] * .5);
      const ds = Math.round(shares[d] + base * p.shareRate[0] * .5);
      const gained = Math.round(dv * p.followPerView * between(.7, 1.3));
      const lost = Math.round(gained * between(.08, .25));
      followers += gained - lost;
      daily[pf].push({ date: iso(date), followers, newFollowers: gained - lost, views: dv, likes: dl, comments: dc, shares: ds });
    }
  });

  // ------------ Commentaires ------------
  const firstNames = ['Camille', 'Lucas', 'Léa', 'Hugo', 'Chloé', 'Nathan', 'Manon', 'Théo', 'Inès', 'Louis', 'Sarah', 'Jules', 'Emma',
    'Mathis', 'Zoé', 'Yanis', 'Clara', 'Adam', 'Juliette', 'Rayan', 'Anaïs', 'Paul', 'Lina', 'Maxime', 'Nora', 'Antoine', 'Élise', 'Karim', 'Margaux', 'Samuel'];
  const lastNames = ['Martin', 'Bernard', 'Dubois', 'Lefèvre', 'Moreau', 'Garnier', 'Roux', 'Fournier', 'Girard', 'Bonnet', 'Mercier',
    'Lambert', 'Fontaine', 'Rousseau', 'Vincent', 'Chevalier', 'Blanc', 'Guérin', 'Perrin', 'Morel'];
  const jobs = ['Gérante de boutique', 'Développeur front', 'Architecte', 'Kinésithérapeute', 'Responsable marketing', 'Artisan menuisier',
    'Consultante SEO', 'Fondateur de start-up', 'Designer UX', 'Chargée de communication', 'Restaurateur', 'Freelance'];

  const texts = {
    positive: [
      'Super contenu, merci pour les conseils !', 'Le avant/après est bluffant 🔥', 'Exactement ce que je cherchais pour mon site.',
      'Très clair, j\'ai enfin compris la différence.', 'Vous bossez avec quels outils ? C\'est top.', 'Magnifique travail sur la typographie.',
      'Je partage à mon équipe, merci !', 'Toujours aussi qualitatif 👏', 'Le rendu mobile est parfait.', 'Enfin quelqu\'un qui parle d\'accessibilité !',
      'On a appliqué le conseil n°2, résultat immédiat.', 'Hâte de voir la suite de la série.'
    ],
    neutral: [
      'Vous travaillez aussi avec des clients hors de France ?', 'C\'est quoi le délai moyen pour un site vitrine ?', 'Ça marche aussi avec WordPress ?',
      'Quel hébergeur vous recommandez ?', 'Vous avez un lien vers le projet ?', 'Intéressant, à tester.', 'Et pour un e-commerce, même principe ?',
      'La vidéo complète est dispo où ?', 'Vous faites aussi la maintenance ?', 'Quelle police sur le visuel 3 ?'
    ],
    negative: [
      'Un peu trop rapide, difficile de suivre.', 'Pas d\'accord, les page builders font très bien le job.', 'Le son est trop fort sur la fin.',
      'Les prix ne sont pas indiqués, dommage.', 'Je trouve ça un peu survendu.', 'Le lien en bio ne fonctionne pas.',
      'Déjà vu 100 fois ce type de conseil.', 'Mon site a planté après avoir suivi ce tuto…'
    ]
  };

  const commentsList = [];
  let cSeq = 1;
  const nowMs = Date.now();
  posts.forEach((post) => {
    const n = Math.min(12, Math.max(0, Math.round(post.comments / 18 + between(-1, 2))));
    const pubMs = new Date(post.publishedAt).getTime();
    for (let i = 0; i < n; i++) {
      const sentiment = weighted([['positive', 58], ['neutral', 29], ['negative', 13]]);
      const fn = pick(firstNames), ln = pick(lastNames);
      const created = Math.min(nowMs - 60000, pubMs + Math.pow(rand(), 2.2) * 6 * 86400000);
      const handle = post.platform === 'linkedin'
        ? pick(jobs)
        : '@' + (fn + (rand() < .5 ? '.' : '_') + ln).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + (rand() < .4 ? Math.floor(rand() * 99) : '');
      commentsList.push({
        id: `c-${String(cSeq++).padStart(5, '0')}`,
        platform: post.platform,
        postId: post.id,
        author: post.platform === 'linkedin' ? `${fn} ${ln}` : `${fn} ${ln.charAt(0)}.`,
        handle,
        text: pick(texts[sentiment]),
        sentiment,
        likes: Math.round(Math.pow(rand(), 3) * (post.platform === 'tiktok' ? 320 : 60)),
        createdAt: new Date(created).toISOString()
      });
    }
  });

  // ------------ Insights du compte Instagram (mêmes formes que GET /api/platforms/instagram/insights) ------------
  // Uniquement les métriques fournies par l'API Meta (voir connexion.md §3). Comme l'API, les comptes uniques
  // (spectateurs, comptes ayant interagi) ne sont pas fournis sur 90 jours.
  function igInsights() {
    const d = daily.instagram;
    const sumK = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
    const shareF = between(.04, .09), viewMult = between(1.5, 1.8);
    const one = (arr, uniquesOk) => {
      const reach = sumK(arr, 'views'), likes = sumK(arr, 'likes'), comments = sumK(arr, 'comments'), shares = sumK(arr, 'shares');
      const net = sumK(arr, 'newFollowers');
      const views = Math.round(reach * viewMult);
      const saves = Math.round(likes * .08), reposts = Math.round(shares * .2), replies = Math.round(comments * .3);
      const taps = Math.round(views * .004);
      const follows = Math.round(Math.max(0, net) / .85);
      return {
        views, viewsFollowers: Math.round(views * shareF), viewsNonFollowers: views - Math.round(views * shareF),
        viewers: uniquesOk ? Math.round(reach * .5) : null,
        viewersFollowers: uniquesOk ? Math.round(reach * .5 * shareF * 1.4) : null,
        likes, comments, shares, saves, reposts, replies,
        total: likes + comments + shares + saves + replies,
        engaged: uniquesOk ? Math.round((likes + comments + shares + saves) * .55) : null,
        taps, address: Math.round(taps * .4), call: Math.round(taps * .25), email: Math.round(taps * .2), book: taps - Math.round(taps * .4) - Math.round(taps * .25) - Math.round(taps * .2),
        follows, unfollows: follows - net, net
      };
    };
    const byPeriod = {};
    [7, 30, 90].forEach((P) => {
      const n = d.length;
      const c = one(d.slice(n - P), P <= 30), p = one(d.slice(n - 2 * P, n - P), P <= 30);
      const K = (k) => (c[k] === null ? null : { value: c[k], previous: p[k] });
      const views = c.views;
      byPeriod[P] = {
        generatedAt: new Date().toISOString(),
        views: {
          total: K('views'), followers: K('viewsFollowers'), nonFollowers: K('viewsNonFollowers'),
          byContentType: [['REEL', 'Reels', .55], ['CAROUSEL_CONTAINER', 'Carrousels', .2], ['POST', 'Publications', .15], ['STORY', 'Stories', .1]]
            .map(([key, label, w]) => ({ key, label, value: Math.round(views * w) })),
          viewers: K('viewers'),
          viewersFollowers: K('viewersFollowers'),
          viewersNonFollowers: c.viewers === null ? null : { value: c.viewers - c.viewersFollowers, previous: p.viewers - p.viewersFollowers }
        },
        interactions: {
          total: K('total'), engagedAccounts: K('engaged'), likes: K('likes'), saves: K('saves'), comments: K('comments'),
          shares: K('shares'), reposts: K('reposts'), replies: K('replies')
        },
        profile: {
          linkTaps: K('taps'), addressTaps: K('address'),
          byButton: [['DIRECTION', "Adresse de l'entreprise", c.address], ['CALL', 'Appeler', c.call], ['EMAIL', 'E-mail', c.email], ['BOOK_NOW', 'Réserver', c.book]]
            .filter((x) => x[2] > 0).map(([key, label, value]) => ({ key, label, value })).sort((a, b) => b.value - a.value),
          follows: K('follows'), unfollows: K('unfollows'), netFollowers: K('net')
        },
        errors: {},
        notes: P > 30 ? ['Comptes uniques (spectateurs, comptes ayant interagi) : Meta ne les calcule pas sur 90 jours ; affichez 7 ou 30 jours.'] : []
      };
    });
    const dist = (entries, total, sortByKey) => {
      const w = entries.map(([, , x]) => x * between(.85, 1.15));
      const sw = w.reduce((s, x) => s + x, 0);
      const out = entries.map(([key, label], i) => ({ key, label, value: Math.round(total * w[i] / sw) }));
      return sortByKey ? out : out.sort((a, b) => b.value - a.value);
    };
    const AGES = [['13-17', '13-17', 1], ['18-24', '18-24', 14], ['25-34', '25-34', 38], ['35-44', '35-44', 26], ['45-54', '45-54', 13], ['55-64', '55-64', 6], ['65+', '65+', 2]];
    const GENDERS = [['F', 'Femmes', 58], ['M', 'Hommes', 40], ['U', 'Non précisé', 2]];
    const COUNTRIES = [['FR', 'FR', 82], ['BE', 'BE', 6], ['CH', 'CH', 4], ['CA', 'CA', 3], ['MA', 'MA', 2], ['LU', 'LU', 1]];
    const CITIES = [['Paris, Île-de-France', 'Paris, Île-de-France', 22], ['Lyon, Auvergne-Rhône-Alpes', 'Lyon, Auvergne-Rhône-Alpes', 12],
      ['Marseille, Provence-Alpes-Côte d\'Azur', 'Marseille, Provence-Alpes-Côte d\'Azur', 7], ['Bordeaux, Nouvelle-Aquitaine', 'Bordeaux, Nouvelle-Aquitaine', 6],
      ['Nantes, Pays de la Loire', 'Nantes, Pays de la Loire', 5], ['Lille, Hauts-de-France', 'Lille, Hauts-de-France', 5], ['Toulouse, Occitanie', 'Toulouse, Occitanie', 4],
      ['Bruxelles, Région de Bruxelles-Capitale', 'Bruxelles, Région de Bruxelles-Capitale', 3]];
    const block = (total, timeframe) => ({
      timeframe,
      age: dist(AGES, total, true), gender: dist(GENDERS, total), country: dist(COUNTRIES, total * .97), city: dist(CITIES, total * .64)
    });
    const followersNow = d[d.length - 1].followers;
    const onlineHours = Array.from({ length: 24 }, (_, h) => {
      const curve = h < 6 ? .08 : h < 9 ? .25 + (h - 6) * .1 : h < 12 ? .45 : h < 14 ? .58 : h < 18 ? .5 : h < 22 ? .72 : .4;
      return Math.round(followersNow * curve * between(.92, 1.08));
    });
    return {
      byPeriod,
      audience: {
        status: 'ok', threshold: 100, followersCount: followersNow,
        followers: block(followersNow, 'this_month'),
        engaged: block(Math.round(followersNow * .12), 'last_30_days'),
        onlineHours
      }
    };
  }

  window.MOCK_DATA = { generatedAt: new Date().toISOString(), accounts, daily, posts, comments: commentsList, insights: { instagram: igInsights() } };
})();
