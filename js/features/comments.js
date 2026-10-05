/* Commentaires agrégés (#/social/comments) : filtres, flux, lien vers la publication, méthode du sentiment, réseaux sans commentaires. */
import { esc, number, pct, fmtDateTime, relTime } from '../core/format.js?v=17';
import { PLATFORMS, PLATFORM_LABELS as LABELS, SENT } from '../core/labels.js?v=17';
import { state } from '../core/state.js?v=17';
import { Tabs, TabPanel, StatusBadge, EmptyState, ExternalLink } from '../ui/components.js?v=17';
import { platformBadge, ICON } from '../ui/icons.js?v=17';
import { SOCIAL_TABS } from './tabs.js?v=17';
import { scrub } from './social-shared.js?v=17';

const Api = window.Api, Charts = window.Charts;
const $ = (sel, root = document) => root.querySelector(sel);

export const title = 'Commentaires';
export const eyebrow = '';
export const usesToolbar = false;

const SENT_KIND = { positive: 'ok', neutral: 'neutral', negative: 'error' };

function commentItems(items, q, urls) {
  const hl = (s) => {
    const safe = esc(s);
    if (!q) return safe;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  };
  const t = Charts.theme();
  return items.map((c) => {
    const url = c.post && urls.get(`${c.platform}:${c.post.id}`);
    const author = c.author || 'Auteur inconnu';
    return `
    <li class="comment">
      <span class="avatar" aria-hidden="true" style="background:${t.platform[c.platform]}">${esc(author.charAt(0))}</span>
      <article aria-label="Commentaire de ${esc(author)}">
        <div class="comment__head">
          <span class="comment__author">${hl(author)}</span>${c.handle ? `<span class="comment__handle">${hl(c.handle)}</span>` : ''}
          ${platformBadge(c.platform)}${StatusBadge({ kind: SENT_KIND[c.sentiment] || 'neutral', label: SENT[c.sentiment] || 'Neutre' })}
          <time class="comment__date" datetime="${esc(c.createdAt)}" title="${esc(fmtDateTime(c.createdAt))}">${esc(relTime(c.createdAt))}</time>
        </div>
        <p class="comment__text">${hl(c.text)}</p>
        <div class="comment__foot"><span>${ICON.heart} ${number(c.likes)} <span class="sr-only">j'aime</span></span>
          ${c.post ? `<span class="comment__post">Sur : ${hl(c.post.title || 'publication sans titre')}</span>${c.post.type ? `<span class="tag">${esc(c.post.type)}</span>` : ''}` : ''}
          ${url ? ExternalLink({ href: url, label: 'Voir la publication', ariaLabel: `Voir la publication de ce commentaire de ${author}` }) : ''}</div>
      </article>
    </li>`;
  }).join('');
}

export async function render(ctx) {
  const f = state.comments;
  // Adresses des publications (pour « Voir la publication ») : un seul appel, mis en correspondance par réseau + identifiant.
  const urls = new Map();
  try { (await Api.getPosts({ period: ctx.period })).forEach((p) => { if (p.url) urls.set(`${p.platform}:${p.id}`, p.url); }); } catch (e) { if (e && e.code === 'unauthenticated') throw e; }
  const markup = Tabs({ items: SOCIAL_TABS, current: 'comments', label: 'Réseaux sociaux' }) + TabPanel('comments', `
    <section class="card" aria-labelledby="cm-filters">
      <h2 class="sr-only" id="cm-filters">Filtres</h2>
      <form class="filters" id="cm-form" role="search">
        <div class="field field--search"><label for="cm-q">Rechercher</label><input id="cm-q" type="search" placeholder="Texte, auteur, publication…" value="${esc(f.q)}" autocomplete="off"></div>
        <div class="field"><label for="cm-pf">Plateforme</label><select id="cm-pf"><option value="">Toutes</option>${PLATFORMS.map((p) => `<option value="${p}" ${f.platform === p ? 'selected' : ''}>${LABELS[p]}</option>`).join('')}</select></div>
        <div class="field"><label for="cm-s">Sentiment</label><select id="cm-s"><option value="">Tous</option>${Object.entries(SENT).map(([k, v]) => `<option value="${k}" ${f.sentiment === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <button type="button" class="btn btn-ghost" id="cm-reset">Réinitialiser</button>
      </form>
    </section>
    <div id="cm-gaps"></div>
    <div id="cm-kpis"></div>
    <section class="card" aria-labelledby="cm-title">
      <div class="card__head"><div><h2 class="card__title" id="cm-title">Flux des commentaires</h2><span class="card__sub results-count" id="cm-count" role="status"></span></div></div>
      <ul class="comment-list" id="cm-list"></ul>
      <div class="center-row"><button type="button" class="btn btn-ghost" id="cm-more" hidden>Afficher plus</button></div>
    </section>
    <details class="card fold" id="cm-method"><summary class="fold__sum"><span class="fold__txt"><h2 class="card__title">Comment lire ces commentaires</h2><span class="card__sub">Méthode du sentiment et conservation</span></span></summary><div class="fold__body"><ul class="limits__list">
      <li>Le sentiment (positif, neutre, négatif) est <strong>estimé</strong> par un lexique simple de mots et d’émojis en français et en anglais. Il est indicatif : l’ironie, les nuances et le contexte ne sont pas compris, aucune plateforme ne fournit cette information.</li>
      <li>Les commentaires LinkedIn ne sont conservés que 48 heures au maximum.</li>
      <li>La période choisie (${ctx.period} jours) s’applique à la date du commentaire.</li></ul></div></details>`);

  async function refresh({ resetShown = true } = {}) {
    if (resetShown) f.shown = 25;
    const { stats, items, unavailable = [] } = await Api.getComments({ platform: f.platform, sentiment: f.sentiment, q: f.q, period: ctx.period });
    if (!$('#cm-list')) return;
    const share = (n) => (stats.total ? pct(n / stats.total * 100, 0) : '—');
    const gaps = unavailable.filter((u) => !f.platform || u.platform === f.platform);
    $('#cm-gaps').innerHTML = gaps.length
      ? `<section class="card" aria-label="Réseaux sans commentaires">${EmptyState({ title: `Pas de commentaires pour ${gaps.map((u) => LABELS[u.platform]).join(' et ')}`, cause: gaps.map((u) => scrub(u.reason)).join(' ') })}</section>` : '';
    const kpi = (label, value, sub) => `<div class="kpi"><span class="kpi__label">${esc(label)}</span><span class="kpi__value">${esc(value)}</span><span class="kpi__delta"><span class="prev">${esc(sub)}</span></span></div>`;
    $('#cm-kpis').innerHTML = stats.total
      ? `<section class="kpis" style="--cols:4;--cols-md:2" aria-label="Synthèse des commentaires">${kpi('Commentaires', number(stats.total), `${ctx.period} derniers jours`)}${kpi('Positifs (estimé)', share(stats.positive), `${number(stats.positive)} commentaires`)}${kpi('Neutres (estimé)', share(stats.neutral), `${number(stats.neutral)} commentaires`)}${kpi('Négatifs (estimé)', share(stats.negative), `${number(stats.negative)} commentaires`)}</section>` : '';
    const visible = items.slice(0, f.shown);
    $('#cm-list').innerHTML = visible.length ? commentItems(visible, f.q.trim(), urls) : `<li>${EmptyState({ title: 'Aucun commentaire', cause: 'Aucun commentaire ne correspond à ces filtres sur la période.' })}</li>`;
    const msg = `${number(stats.total)} commentaire${stats.total > 1 ? 's' : ''}${visible.length < stats.total ? ` · ${visible.length} affichés` : ''}`;
    $('#cm-count').textContent = msg;
    $('#cm-more').hidden = visible.length >= items.length;
    ctx.announce(msg);
  }

  return {
    markup,
    after() {
      let timer;
      $('#cm-form').addEventListener('submit', (e) => e.preventDefault());
      $('#cm-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; refresh(); }, 200); });
      $('#cm-pf').addEventListener('change', (e) => { f.platform = e.target.value; refresh(); });
      $('#cm-s').addEventListener('change', (e) => { f.sentiment = e.target.value; refresh(); });
      $('#cm-reset').addEventListener('click', () => { Object.assign(f, { platform: '', sentiment: '', q: '' }); $('#cm-q').value = ''; $('#cm-pf').value = ''; $('#cm-s').value = ''; refresh(); });
      $('#cm-more').addEventListener('click', () => { f.shown += 25; refresh({ resetShown: false }); });
      refresh();
    }
  };
}
