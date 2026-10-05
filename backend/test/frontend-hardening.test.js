// Durcissement statique du front, de nginx et des conteneurs (audit 10/2026) : vérifications de non-régression hors réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGES = ['index.html', 'login.html', 'confidentialite.html', 'conditions.html'];

test('Pages : aucune ressource Google Fonts ; polices auto-hébergées présentes avec leur licence', () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<li>[\s\S]*?<\/li>/g, '')), `${p} : aucune requête Google Fonts`);
    assert.match(html, /assets\/fonts\/manrope-latin-wght-normal\.woff2/);
  }
  const css = read('css/theme.css');
  for (const f of ['manrope-latin-wght-normal.woff2', 'manrope-latin-ext-wght-normal.woff2']) {
    assert.ok(css.includes(`../assets/fonts/${f}`));
    assert.ok(fs.statSync(path.join(root, 'assets/fonts', f)).size > 1000);
  }
  assert.match(read('assets/fonts/OFL-Manrope.txt'), /SIL Open Font License/);
});

test('Pages privées : noindex ; AUCUN script ni CDN tiers ; Chart.js auto-hébergé, intègre et sous licence', async () => {
  for (const p of ['index.html', 'login.html']) assert.match(read(p), /<meta name="robots" content="noindex, nofollow">/, p);
  for (const p of PAGES) {
    const html = read(p).replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(![...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:)?\/\/[^"]+"/g)].length, `${p} : aucune ressource externe`);
    assert.ok(!/cdnjs|cdn\.jsdelivr|unpkg/.test(html), `${p} : aucune référence CDN`);
  }
  for (const f of ['nginx.conf', 'js/charts.js', 'js/app.js']) assert.ok(!/cdnjs\.cloudflare\.com/.test(read(f)), `${f} : aucune référence CDN`);
  const m = read('index.html').match(/<script src="js\/lib\/chart\.umd\.min\.js\?v=4\.4\.1" integrity="(sha384-[A-Za-z0-9+/=]+)"><\/script>/);
  assert.ok(m, 'Chart.js local avec SRI');
  const { createHash } = await import('node:crypto');
  const lib = fs.readFileSync(path.join(root, 'js/lib/chart.umd.min.js'));
  assert.equal(`sha384-${createHash('sha384').update(lib).digest('base64')}`, m[1], 'empreinte SRI = fichier livré');
  assert.match(lib.subarray(0, 200).toString(), /Chart\.js v4\.4\.1/);
  assert.match(read('js/lib/LICENSE-chartjs.md'), /MIT License/);
  assert.match(read('nginx.conf'), /script-src 'self';/);
});

test('nginx : X-Robots-Tag et HSTS sur zone privée/API, vrai 404 (aucun fallback index.html), CSS/JS revalidés', () => {
  const conf = read('nginx.conf');
  const loc = (name) => { const i = conf.indexOf(name); assert.ok(i >= 0, name); return conf.slice(i, conf.indexOf('}', i)); };
  for (const l of ['location /api/', 'location = /index.html', 'location / {', 'location ~* \\.(?:css|js)$']) {
    assert.match(loc(l), /add_header X-Robots-Tag \$robots always;/, l);
    assert.match(loc(l), /add_header Strict-Transport-Security \$hsts always;/, l);
  }
  assert.match(conf, /set \$hsts "max-age=31536000";/);
  assert.match(loc('location / {'), /try_files \$uri \$uri\/ =404;/);
  assert.ok(!/try_files[^;]*\/index\.html;/.test(conf), 'aucun fallback HTML');
  assert.match(loc('location ~* \\.(?:css|js)$'), /Cache-Control "no-cache"/);
  // pages légales publiques : indexables mais protégées
  assert.ok(!/X-Robots-Tag/.test(loc('location = /confidentialite {')));
  assert.match(loc('location = /confidentialite {'), /Strict-Transport-Security/);
});

test('Conteneurs : web non-root et épinglé par digest ; compose en lecture seule, sans DAC_OVERRIDE, limites de ressources', () => {
  const web = read('Dockerfile');
  assert.match(web, /^FROM nginx:alpine@sha256:[a-f0-9]{64}$/m);
  assert.match(web, /^USER nginx$/m);
  assert.match(web, /pid \/tmp\/nginx\.pid/);
  const compose = read('docker-compose.yml');
  const svc = (name) => { const i = compose.indexOf(`\n  ${name}:\n`); const rest = compose.slice(i + 1); const next = rest.slice(1).search(/\n  [a-z-]+:\n|\nnetworks:/); return rest.slice(0, next + 1); };
  for (const s of ['web', 'api', 'api-init']) {
    assert.match(svc(s), /read_only: true/, s);
    assert.match(svc(s), /cap_drop:\n\s+- ALL/, s);
    assert.match(svc(s), /no-new-privileges:true/, s);
  }
  for (const s of ['web', 'api']) { assert.match(svc(s), /mem_limit: \d+m/, s); assert.match(svc(s), /pids_limit: \d+/, s); }
  assert.ok(!/DAC_OVERRIDE\n/.test(svc('api-init').replace(/#.*$/gm, '')), 'DAC_OVERRIDE retiré');
  assert.match(svc('api-init'), /network_mode: none/);
  assert.ok(!/docker\.sock/.test(compose.replace(/#.*$/gm, '')), 'aucun socket Docker monté');
});

test('Front : aucune saisie de code (second facteur supprimé) ; actions d’infrastructure confirmées par dialogue seul', () => {
  const api = read('js/api.js');
  assert.match(api, /redeploy: \(type, id\) =>[^\n]+body: \{ confirmed: true \}/);
  assert.match(api, /reloadApplication: \(id\) =>[^\n]+body: \{ confirmed: true \}/);
  const dialog = read('js/ui/dialog.js');
  assert.match(dialog, /const operation = await cfg\.run\(\);/);
  const infra = read('js/features/infra-shared.js');
  assert.match(infra, /run: \(\) => Api\.redeploy\(/);
  assert.match(infra, /run: \(\) => Api\.reloadApplication\(/);
  for (const f of ['js/api.js', 'js/ui/dialog.js', 'js/login.js', 'login.html']) assert.doesNotMatch(read(f), /totp|second_?factor|one-time-code/i);
  assert.match(read('js/features/settings-sections.js'), /data-logout-all/);
});

test('Confidentialité : cache persistant chiffré décrit, police exacte, plus d’affirmation « jamais sur disque » pour les statistiques', () => {
  const html = read('confidentialite.html');
  assert.match(html, /cache\.enc\.json/);
  assert.match(html, /plus de 7 jours est supprimée/);
  assert.ok(!/IBM Plex/.test(html));
  assert.ok(!/Statistiques, publications et commentaires<\/strong> : conservés uniquement/.test(html));
  assert.match(html, /<strong>Commentaires<\/strong> : conservés uniquement <strong>en mémoire vive<\/strong>/);
});
