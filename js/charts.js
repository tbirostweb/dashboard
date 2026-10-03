/* Wrappers Chart.js stylés avec les variables CSS du thème. */
(function () {
  'use strict';

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const registry = new Set();
  let quiet = false; // mise à jour silencieuse du mode en direct : aucun graphique n'est animé à sa recréation

  const px = (name, fallback) => { const n = parseFloat(css(name)); return Number.isFinite(n) ? n : fallback; }; // rayons lus dans theme.css (aucune valeur en dur)
  const dashOf = (name) => { const v = css(name); return !v || v === 'none' ? [] : v.split(/\s+/).map(Number); };
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function theme() {
    return {
      ink: css('--ink'), gray: css('--gray'), line: css('--line'), line2: css('--line-2'),
      surface: css('--surface'), surface2: css('--surface-2'), accent: css('--accent'), inkDark: css('--ink-dark'), soft: css('--soft'),
      mono: css('--fm'), body: css('--fb'),
      platform: { tiktok: css('--c-tiktok'), instagram: css('--c-instagram'), linkedin: css('--c-linkedin') },
      // Motifs de trait distincts par plateforme : la couleur ne porte jamais seule la distinction
      dash: { instagram: dashOf('--dash-instagram'), tiktok: dashOf('--dash-tiktok'), linkedin: dashOf('--dash-linkedin') }
    };
  }

  function applyDefaults() {
    if (!window.Chart) return;
    const t = theme();
    Chart.defaults.font.family = t.mono;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = t.gray;
    Chart.defaults.borderColor = t.line2;
    Chart.defaults.animation.duration = reduced() ? 0 : 400;
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: t.ink, titleColor: t.inkDark, bodyColor: t.inkDark, borderWidth: 0,
      cornerRadius: px('--r-ctl', 8), padding: 12, boxPadding: 4, titleFont: { family: t.mono, weight: '500' }, bodyFont: { family: t.mono }
    });
    Chart.defaults.plugins.legend.display = false;
  }

  const nf = new Intl.NumberFormat('fr-FR');
  const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
  const shortDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });

  function make(canvas, config) {
    if (!window.Chart) {
      canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Graphique indisponible (Chart.js non chargé).' }));
      return null;
    }
    if (reduced() || quiet) config.options = Object.assign({}, config.options, { animation: false });
    const chart = new Chart(canvas, config);
    registry.add(chart);
    enableKeyboard(canvas, chart);
    return chart;
  }

  /** Infobulle accessible au clavier : ← → parcourent les points, Échap la ferme (le résumé et le tableau restent la lecture de référence). */
  function enableKeyboard(canvas, chart) {
    let idx = -1;
    const show = () => {
      const n = (chart.data.labels || []).length; if (!n) return;
      idx = (idx + n) % n;
      const els = chart.data.datasets.map((_, di) => ({ datasetIndex: di, index: idx }));
      chart.setActiveElements(els);
      chart.tooltip.setActiveElements(els, { x: 0, y: 0 });
      chart.update();
    };
    canvas.addEventListener('keydown', (e) => {
      if (chart.config.type === 'doughnut' || chart.config.type === 'scatter') return;
      if (e.key === 'ArrowRight') { idx += 1; e.preventDefault(); show(); }
      else if (e.key === 'ArrowLeft') { idx = idx < 0 ? 0 : idx - 1; e.preventDefault(); show(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { chart.setActiveElements([]); chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update(); idx = -1; }
    });
    canvas.addEventListener('blur', () => { idx = -1; chart.setActiveElements([]); chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update(); });
  }

  function baseScales({ yFormat = (v) => compact.format(v), stacked = false } = {}) {
    const t = theme();
    return {
      x: { stacked, grid: { display: false }, border: { color: t.line }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 16, maxTicksLimit: 7 } },
      y: { stacked, beginAtZero: true, grid: { color: t.line2 }, border: { display: false }, ticks: { callback: yFormat, maxTicksLimit: 6 } }
    };
  }

  const Charts = {
    destroyAll() { registry.forEach((c) => c.destroy()); registry.clear(); },
    quiet(on) { quiet = Boolean(on); },
    destroy(chart) { if (chart && registry.has(chart)) { registry.delete(chart); chart.destroy(); } },
    theme,

    /**
     * Courbes multi-séries. series: [{label, data, color, platform?, fill?, dashed?, dash?, connect?}] ; `platform` impose couleur et motif de trait du thème.
     * Valeur absente (null) = jour sans mesure, jamais 0. Les points sont toujours dessinés (jusqu'à 45 valeurs mesurées, et dans tous les cas
     * pour un point isolé entre deux jours sans mesure) : sans eux une série « un jour sur dix » (interactions rattachées au jour de publication)
     * n'avait AUCUN segment et donc aucune marque visible. `connect: true` relie les points à travers les jours sans mesure (sinon trous).
     */
    lines(canvas, { labels, series, yFormat, tooltipFormat = (v) => nf.format(v) }) {
      const scales = baseScales({ yFormat });
      if (series.some((s) => s.axis === 'y1')) {
        // Double axe : série principale à gauche (échelle ajustée), secondaire à droite
        scales.y.beginAtZero = false;
        scales.y.grace = '10%';
        scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { callback: (v) => compact.format(v), maxTicksLimit: 6 } };
      }
      const known = (v) => typeof v === 'number' && Number.isFinite(v);
      return make(canvas, {
        type: 'line',
        data: {
          labels: labels.map(shortDate),
          datasets: series.map((s) => {
            const t = theme(), color = s.color || t.platform[s.platform] || t.ink, dash = s.dash || (s.platform ? t.dash[s.platform] : s.dashed ? [4, 4] : []);
            const data = s.data.map((v) => (known(v) ? v : null));
            const count = data.filter((v) => v !== null).length;
            const radius = data.map((v, i) => (v === null ? 0 : count <= 45 || (data[i - 1] == null && data[i + 1] == null) ? 3.5 : 0));
            return {
              label: s.label, data, borderColor: color, backgroundColor: /^#[0-9a-f]{6}$/i.test(color) ? color + '22' : color,
              fill: !!s.fill, borderWidth: 2, tension: s.connect ? 0 : .3, pointRadius: radius, pointHoverRadius: 6,
              pointBackgroundColor: color, pointBorderColor: t.surface, pointBorderWidth: 1.5, pointHoverBackgroundColor: color,
              borderDash: dash, yAxisID: s.axis || 'y', spanGaps: Boolean(s.connect)
            };
          })
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales,
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${c.parsed.y === null ? 'aucune mesure' : tooltipFormat(c.parsed.y)}` } } }
        }
      });
    },

    /** Nuage de points : series [{label, color, points: [{x, y, label?}]}] ; xLabel / yLabel = titres d'axes. */
    scatter(canvas, { series, xLabel = '', yLabel = '', xFormat = (v) => nf.format(v), yFormat = (v) => compact.format(v), tooltipFormat }) {
      const t = theme();
      return make(canvas, {
        type: 'scatter',
        data: { datasets: series.map((s) => ({ label: s.label, data: s.points, backgroundColor: s.color || t.ink, borderColor: t.surface, borderWidth: 1.5, pointRadius: 5, pointHoverRadius: 7 })) },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { type: 'linear', beginAtZero: true, title: { display: Boolean(xLabel), text: xLabel, color: t.gray }, grid: { color: t.line2 }, border: { color: t.line }, ticks: { callback: xFormat, maxTicksLimit: 8 } },
            y: { beginAtZero: true, title: { display: Boolean(yLabel), text: yLabel, color: t.gray }, grid: { color: t.line2 }, border: { display: false }, ticks: { callback: yFormat, maxTicksLimit: 6 } }
          },
          plugins: { tooltip: { callbacks: { label: (c) => (tooltipFormat ? tooltipFormat(c.raw) : ` ${xFormat(c.parsed.x)} → ${yFormat(c.parsed.y)}`) } } }
        }
      });
    },

    /** Barres. */
    bars(canvas, { labels, series, horizontal = false, yFormat, tooltipFormat = (v) => nf.format(v), stacked = false }) {
      const scales = baseScales({ yFormat, stacked });
      if (horizontal) {
        const x = scales.x; scales.x = scales.y; scales.y = x;
        // Axe des catégories : afficher toutes les étiquettes (listes courtes : types, pays, villes)
        scales.y.ticks = { ...scales.y.ticks, autoSkip: false, maxTicksLimit: undefined };
      }
      return make(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: series.map((s) => ({
            label: s.label, data: s.data, backgroundColor: s.colors || s.color, borderRadius: px('--r-bar', 2),
            maxBarThickness: 36, categoryPercentage: .7, barPercentage: .9
          }))
        },
        options: {
          indexAxis: horizontal ? 'y' : 'x',
          responsive: true, maintainAspectRatio: false,
          scales,
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${tooltipFormat(horizontal ? c.parsed.x : c.parsed.y)}` } } }
        }
      });
    },

    /** Anneau de répartition. */
    doughnut(canvas, { labels, data, colors }) {
      const t = theme();
      const total = data.reduce((s, v) => s + v, 0) || 1;
      return make(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: t.surface, borderWidth: 3, hoverOffset: 4 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '68%',
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.label} : ${nf.format(c.parsed)} (${(c.parsed / total * 100).toFixed(1).replace('.', ',')} %)` } } }
        }
      });
    }
  };

  applyDefaults();
  window.Charts = Charts;
})();
