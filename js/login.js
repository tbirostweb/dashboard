/* Page de connexion : POST /api/auth/login → cookie de session httpOnly posé par le serveur. */
(function () {
  'use strict';

  const form = document.getElementById('login-form');
  const input = document.getElementById('password');
  const error = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');

  // Destination après connexion : uniquement une ancre locale (#/…), jamais une URL externe
  const next = new URLSearchParams(location.search).get('next') || '';
  const target = /^#\/[a-z]+(\/[a-z]+)?$/.test(next) ? `./${next}` : './';

  // Redirection depuis une 401 : simple indicateur ?expired=1, aucune donnée sensible
  if (new URLSearchParams(location.search).get('expired') === '1') document.getElementById('login-notice').hidden = false;

  // Déjà connecté ? on repart directement vers le dashboard
  fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && d.authenticated) location.replace(target); })
    .catch(() => { /* API indisponible : on laisse le formulaire */ });

  // Après une connexion réussie : préchauffe le cache du serveur (vue d'ensemble, statut, infrastructure) pendant la navigation vers le tableau de bord.
  // keepalive : les requêtes se terminent même si la page est quittée ; les réponses ne sont pas lues (aucune donnée de compte conservée ici).
  function warmUp() {
    let period = 30;
    try { const p = Number(localStorage.getItem('sd.period')); if ([7, 30, 90].includes(p)) period = p; } catch (e) { /* stockage indisponible */ }
    [`/api/overview?period=${period}`, '/api/status', '/api/infrastructure'].forEach((u) => {
      try { fetch(u, { credentials: 'same-origin', cache: 'no-store', keepalive: true, headers: { Accept: 'application/json' } }).catch(() => {}); } catch (e) { /* ignore */ }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!input.value) { error.textContent = 'Saisissez le mot de passe.'; input.focus(); return; }
    submit.disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      if (r.ok) { warmUp(); location.replace(target); return; }
      const d = await r.json().catch(() => ({}));
      error.textContent = d.message || `Erreur ${r.status}.`;
      input.select();
    } catch (err) {
      error.textContent = 'Serveur injoignable. Réessayez plus tard.';
    } finally {
      submit.disabled = false;
    }
  });
})();
