/*
 * Formulaire de contact (/contact). Accessible sans compte ; un membre connecté
 * envoie son jeton CSRF et l'e-mail de réponse devient facultatif.
 * Tout ce qui est affiché passe par textContent.
 */
(() => {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const message = $('contact-message');
  const email = $('contact-email');
  const status = $('contact-status');
  const submit = $('contact-submit');
  let csrf = '';
  let signedIn = false;

  const show = (text, kind) => {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = !text;
  };

  const count = () => { $('contact-count').textContent = `${[...message.value].length} / 2000`; };
  message.addEventListener('input', count);

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    return res.ok ? body.data : null;
  }

  (async () => {
    const [config, me] = await Promise.all([getJson('/api/auth/config').catch(() => null), getJson('/api/auth/me').catch(() => null)]);
    if (me && me.user) {
      signedIn = true;
      csrf = me.csrf_token || '';
      email.required = false;
      $('contact-email-label').textContent = 'E-mail de réponse (facultatif)';
      $('contact-email-hint').textContent = 'Sans adresse, on te répond dans l’onglet Messages de l’application.';
    }
    if (config && config.turnstile_site_key && window.HaisselTurnstile) window.HaisselTurnstile.init(config.turnstile_site_key);
  })();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = message.value.trim();
    const length = [...text].length;
    if (length < 20 || length > 2000) { show('Ton message doit contenir entre 20 et 2000 caractères.', 'error'); message.focus(); return; }
    const reply = email.value.trim();
    if (!reply && !signedIn) { show('Indique une adresse e-mail pour qu’on puisse te répondre.', 'error'); email.focus(); return; }

    const body = { subject: $('contact-subject').value, message: text, reply_email: reply };
    const token = window.HaisselTurnstile ? window.HaisselTurnstile.tokenFor(form) : null;
    if (token === '') { show('Valide la vérification anti-robot avant d’envoyer.', 'error'); return; }
    if (token) body.cf_turnstile_response = token;

    submit.disabled = true;
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch('/api/contact', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { show(data.error?.message || 'Envoi impossible. Réessaie dans un instant.', 'error'); return; }
      form.reset();
      count();
      show('Merci, ta demande est bien envoyée. L’équipe te répondra au plus vite.', 'ok');
    } catch (error) {
      show('Envoi impossible : vérifie ta connexion puis réessaie.', 'error');
    } finally {
      submit.disabled = false;
      if (window.HaisselTurnstile) window.HaisselTurnstile.reset(form);
    }
  });
})();
