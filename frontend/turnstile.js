/*
 * Widget Cloudflare Turnstile (anti-robot) partagé par app.js et admin.js.
 *
 * - Seule la clé PUBLIQUE (reçue de /api/auth/config) est utilisée ici.
 * - Un jeton ne sert qu'une fois : le widget est réinitialisé après chaque envoi.
 * - En cas d'échec de chargement, d'expiration ou d'erreur, un message et un
 *   bouton « Réessayer la vérification » sont affichés.
 */
(function turnstileModule() {
  const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=haisselTurnstileReady';
  let siteKey = '';
  let loading = null;
  const widgets = [];

  function loadScript() {
    if (window.turnstile) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      window.haisselTurnstileReady = () => resolve();
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        script.remove();
        loading = null;
        reject(new Error('load'));
      };
      document.head.appendChild(script);
    });
    return loading;
  }

  function createWidget(slot, action) {
    slot.textContent = '';
    slot.classList.remove('hidden');
    slot.hidden = false;
    const holder = document.createElement('div');
    const status = document.createElement('p');
    status.className = 'turnstile-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'text-button turnstile-retry';
    retry.textContent = 'Réessayer la vérification';
    retry.hidden = true;
    slot.append(holder, status, retry);

    const widget = { action, id: null, token: '' };

    function show(message) {
      status.textContent = message;
      status.hidden = !message;
      retry.hidden = !message;
    }

    async function render() {
      show('');
      widget.token = '';
      try {
        await loadScript();
      } catch (error) {
        show('Impossible de charger la vérification anti-robot. Vérifiez votre connexion (ou un bloqueur de contenu), puis réessayez.');
        return;
      }
      if (widget.id !== null) {
        window.turnstile.reset(widget.id);
        return;
      }
      widget.id = window.turnstile.render(holder, {
        sitekey: siteKey,
        action,
        language: 'fr',
        theme: 'auto',
        'refresh-expired': 'auto',
        callback: (token) => { widget.token = token; show(''); },
        'expired-callback': () => { widget.token = ''; },
        'error-callback': () => {
          widget.token = '';
          show('La vérification anti-robot a échoué.');
          return true;
        },
      });
    }

    widget.render = render;
    widget.getToken = () => widget.token || (widget.id !== null ? window.turnstile.getResponse(widget.id) || '' : '');
    widget.reset = () => {
      widget.token = '';
      if (widget.id !== null && window.turnstile) window.turnstile.reset(widget.id);
    };
    retry.addEventListener('click', render);
    render();
    return widget;
  }

  window.HaisselTurnstile = {
    /** Active le widget dans chaque élément [data-turnstile-action] si une clé est fournie. */
    init(publicSiteKey) {
      if (!publicSiteKey || siteKey) return;
      siteKey = publicSiteKey;
      document.querySelectorAll('[data-turnstile-action]').forEach((slot) => {
        widgets.push({ form: slot.closest('form'), widget: createWidget(slot, slot.dataset.turnstileAction) });
      });
    },
    enabled() {
      return Boolean(siteKey);
    },
    /** Jeton du formulaire ('' si non validé ; null si Turnstile inactif). */
    tokenFor(form) {
      if (!siteKey) return null;
      const entry = widgets.find((item) => item.form === form);
      return entry ? entry.widget.getToken() : null;
    },
    /** À appeler après chaque envoi : un jeton est à usage unique. */
    reset(form) {
      const entry = widgets.find((item) => item.form === form);
      if (entry) entry.widget.reset();
    },
  };
}());
