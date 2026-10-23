'use strict';

/*
 * Parcours « Débuter sur MyLead » (11 étapes).
 *
 * - Contenu statique : aucun appel réseau, aucun code à saisir par le membre.
 * - Progression enregistrée uniquement dans ce navigateur (localStorage) :
 *   rien n'est envoyé au serveur.
 * - Libellés repris des guides officiels MyLead (revérifiés le 20/10/2026 sur
 *   les pages référencées ci-dessous, datées du 05/08/2025 pour les sources de
 *   trafic et du 22/08/2025 pour l'obtention du lien) ;
 *   l'interface de MyLead peut évoluer, ce que chaque étape rappelle.
 * - Illustrations : schémas originaux (SVG), pas des captures de MyLead.
 * - Tout le texte est inséré via des nœuds texte (jamais innerHTML).
 */
(function () {
  /*
   * v2 : une étape a été insérée au milieu du parcours. La progression étant
   * stockée sous forme d'indices, réutiliser la clé v1 aurait décalé les
   * étapes déjà cochées d'un cran. On repart donc d'une progression vide
   * plutôt que d'en afficher une fausse.
   */
  const STORAGE_KEY = 'haissel_mylead_progress_v2';
  const OFFICIAL = {
    start: 'https://mylead.global/fr/start',
    register: 'https://pub.mylead.global/register',
    trafficSource: 'https://mylead.global/fr/blog/ajouter-source-de-trafic-sur-mylead',
    link: 'https://mylead.global/en/blog/how-to-download-your-affiliate-link',
  };

  /*
   * Schéma d'écran : { title, rows: [libellé…], highlight: index, note }.
   * Volontairement générique : il montre OÙ chercher, pas une copie de l'écran.
   */
  const STEPS = [
    {
      title: 'Comprendre l’affiliation et le CPL',
      intro: 'Un annonceur paie un partenaire quand une action précise est réalisée grâce à son lien. Avec le CPL (coût par lead), l’action payée est un contact valide : par exemple une inscription complète.',
      instructions: [
        'Lis les guides « L’affiliation, c’est quoi ? » et « Le CPL expliqué » dans l’onglet Apprendre.',
        'Retiens les autres modèles : CPA/CPS (paiement à l’achat), CPI (paiement à l’installation d’une application), CPC (paiement au clic, rare).',
        'Retiens surtout ceci : seule une action validée par l’annonceur est payée, et rien n’est garanti.',
      ],
      figure: { title: 'Le parcours d’un lead', rows: ['1. Clic sur ton lien', '2. Action réalisée', '3. En attente', '4. Validée ou refusée'], highlight: 3, note: 'Seules les actions validées sont payées.' },
      links: [{ label: 'Guide officiel « Pour commencer »', href: OFFICIAL.start }],
      internal: { label: 'Lire les guides HAISSEL', tab: 'guides' },
    },
    {
      title: 'Créer un compte éditeur MyLead',
      intro: 'Le compte éditeur (« publisher ») est gratuit. Il faut 18 ans : HAISSEL ne montre ce parcours qu’aux membres qui l’ont déclaré. Vérifie malgré tout les conditions en vigueur sur le site de MyLead avant de t’inscrire — elles font foi.',
      instructions: [
        'Ouvre la page d’inscription officielle (bouton ci-dessous).',
        'Choisis un identifiant, indique ton adresse e-mail et un mot de passe que tu n’utilises nulle part ailleurs.',
        'Lis puis accepte les consentements demandés.',
        'Ouvre l’e-mail de confirmation envoyé par MyLead et confirme ton compte.',
        'Connecte-toi au panneau éditeur.',
      ],
      warning: 'HAISSEL ne te demandera JAMAIS ton mot de passe ni ton identifiant MyLead. Ne les donne à personne.',
      figure: { title: 'Inscription', rows: ['Identifiant', 'Adresse e-mail', 'Mot de passe', 'Consentements', 'Créer le compte'], highlight: 4, note: 'Les libellés peuvent varier.' },
      links: [{ label: 'Page d’inscription MyLead', href: OFFICIAL.register }],
      referral: true,
    },
    {
      title: 'Compléter son profil et déclarer sa vraie source de trafic',
      intro: 'MyLead demande où tu comptes promouvoir les offres (page, blog, réseau social…). Déclare l’endroit réel : une source fausse ou vague peut entraîner un refus.',
      instructions: [
        'Dans le panneau éditeur, ouvre le menu de gauche (sur téléphone : l’icône menu).',
        'Déroule la section « Marketing d’affiliation » puis choisis « Sources de trafic ».',
        'Appuie sur « Ajouter une source de trafic ».',
        'Choisis le type qui correspond à ce que tu utilises vraiment : site, blog, forum, réseau social, mailing, application mobile, PPC, réseau, ou autre.',
        'Remplis les informations demandées : adresse de ta source, catégories de programmes qui t’intéressent, et les données de ton public (tranche d’âge, répartition, pays).',
        'Indique si ton contenu s’adresse à un public adulte. Réponds honnêtement : c’est ce qui détermine les campagnes qu’on te proposera.',
        'Valide. Tu recevras une notification dans le panneau et un e-mail quand la source sera acceptée (souvent en quelques heures).',
      ],
      figure: { title: 'Menu du panneau', rows: ['Tableau de bord', 'Marketing d’affiliation ▾', '   Sources de trafic', '   Campagnes d’affiliation'], highlight: 2, note: 'D’après le guide officiel du 05/08/2025. Les libellés peuvent varier.' },
      links: [{ label: 'Guide officiel : ajouter une source de trafic', href: OFFICIAL.trafficSource }],
    },
    {
      title: 'Où as-tu le droit de publier ton lien ?',
      intro: 'Avoir un lien ne donne pas le droit de le mettre partout. Tu ne peux publier que là où TU as déclaré une source de trafic acceptée, et seulement si la campagne autorise ce canal. Le reste, c’est au mieux un refus de paiement, au pire la fermeture de ton compte.',
      instructions: [
        'Déclare uniquement TES sources : une page, un compte ou un site qui t’appartient et que tu gères. La page d’un ami, un groupe que tu n’administres pas ou une source inventée ne sont pas les tiennes.',
        'Avant chaque publication, relis la rubrique « trafic autorisé / interdit » de la campagne : elle passe avant tout le reste.',
        'N’envoie pas ton lien en masse : messages groupés, boucles de discussion, commentaires répétés sous des vidéos, serveurs où tu viens d’arriver. C’est du spam, même quand le lien est honnête.',
        'Ne fais pas inscrire tes amis ou ta famille « pour faire monter les chiffres ». Une inscription qui ne vient pas d’un intérêt réel est une fraude : elle est détectée, elle n’est pas payée, et elle met ton compte en danger.',
        'Ne clique jamais sur ton propre lien et ne crée pas de second compte pour contourner un refus.',
        'Dans le doute sur un endroit : ne publie pas. Demande à l’équipe HAISSEL plutôt que de risquer ton compte.',
      ],
      warning: 'Un groupe où « tout le monde poste ses liens » n’est pas une autorisation. Si tu n’as pas déclaré ce canal et que la campagne ne l’autorise pas, tu n’as pas le droit d’y publier.',
      checklist: [
        'C’est une source que j’ai déclarée et qui a été acceptée',
        'La campagne autorise ce canal',
        'Je ne l’envoie pas en masse',
        'Je ne fais inscrire personne « pour aider »',
      ],
      figure: { title: 'Où publier ?', rows: ['✓ Ma source déclarée', '✓ Canal autorisé', '✗ Envoi en masse', '✗ Inscriptions d’amis'], highlight: -1, note: 'Dans le doute, ne publie pas.' },
      links: [{ label: 'Guide officiel : sources de trafic', href: OFFICIAL.trafficSource }],
      internal: { label: 'Lire « Sécurité et légalité »', tab: 'safety' },
    },
    {
      title: 'Trouver une campagne et lire ses conditions',
      intro: 'Une campagne est une offre d’un annonceur. Chaque fiche explique ce qui est payé et ce qui est interdit. Prends le temps de la lire en entier.',
      instructions: [
        'Dans « Marketing d’affiliation », ouvre la liste des campagnes d’affiliation.',
        'Utilise les filtres (pays, catégorie, type de paiement) pour réduire la liste.',
        'Ouvre une fiche qui correspond à ton public.',
        'Lis la description, puis les rubriques sur le trafic autorisé et interdit.',
      ],
      figure: { title: 'Fiche de campagne', rows: ['Description', 'Pays', 'Paiement', 'Trafic autorisé', 'Trafic interdit'], highlight: 4, note: 'Exemple schématique, pas une vraie campagne.' },
      links: [{ label: 'Guide officiel : obtenir son lien', href: OFFICIAL.link }],
    },
    {
      title: 'Vérifier pays, âge, action payée et restrictions',
      intro: 'C’est l’étape qui évite les refus. Si un seul point ne convient pas, choisis une autre campagne.',
      instructions: [
        'Pays : ton public est-il dans un pays accepté ?',
        'Âge minimum : ton public a-t-il l’âge demandé ?',
        'Action payée : qu’est-ce qui est exactement rémunéré (inscription confirmée, installation, achat) ?',
        'Restrictions : quels canaux sont interdits (incitation, spam, publicité payante, mots-clés de marque…) ?',
        'Note ces informations : tu en auras besoin pour publier sur HAISSEL.',
      ],
      checklist: ['Pays vérifiés', 'Âge minimum vérifié', 'Action payée comprise', 'Restrictions lues'],
      figure: { title: 'Ma vérification', rows: ['✓ Pays', '✓ Âge minimum', '✓ Action payée', '✓ Restrictions'], highlight: -1, note: 'En cas de doute, ne publie pas.' },
    },
    {
      title: 'Demander l’accès à la campagne',
      intro: 'Certaines campagnes demandent une validation par l’équipe MyLead avant de te donner un lien.',
      instructions: [
        'Sur la fiche de la campagne, appuie sur le bouton pour la rejoindre (« Join » / « Rejoindre »).',
        'Si on te le demande, choisis ta source de trafic.',
        'Décris honnêtement et en détail comment tu feras la promotion.',
        'Attends la réponse : elle arrive dans les notifications du panneau (en haut à droite) et par e-mail.',
      ],
      figure: { title: 'Demande d’accès', rows: ['Source de trafic', 'Méthode de promotion', 'Envoyer la demande'], highlight: 2, note: 'Délai variable selon MyLead.' },
      links: [{ label: 'Guide officiel : accès et lien', href: OFFICIAL.link }],
    },
    {
      title: 'Copier ton lien d’affiliation',
      intro: 'Une fois la campagne acceptée, MyLead génère ton lien personnel. C’est ce lien que tu publieras.',
      instructions: [
        'Ouvre la campagne acceptée.',
        'Repère la section « Vos configurations » (« Your configurations » si ton panneau est en anglais) : le lien y apparaît automatiquement une fois la campagne acceptée.',
        'Copie le lien : sur téléphone, appuie longuement dessus puis choisis « Copier », ou utilise le bouton de copie s’il y en a un.',
        'Vérifie que le lien commence par « https:// ».',
        'Besoin d’un lien différent par canal ? Ouvre « URL Addresses » dans tes configurations pour en créer un autre.',
      ],
      figure: { title: 'Vos configurations', rows: ['Lien principal', 'https://…', 'Copier'], highlight: 2, note: 'Les libellés peuvent varier.' },
      links: [{ label: 'Guide officiel : obtenir son lien', href: OFFICIAL.link }],
    },
    {
      title: 'Publier ton lien sur HAISSEL',
      intro: 'Remplis le formulaire « Publier ». Décris l’offre honnêtement : ce que c’est, ce qu’il faut faire, pour qui.',
      instructions: [
        'Appuie sur « Publier » dans la barre de navigation.',
        'Colle ton lien dans le champ « Lien ».',
        'Recopie les informations notées à l’étape « Vérifier pays, âge, action payée et restrictions » : pays, âge minimum, action attendue, restrictions.',
        'N’indique une rémunération que si elle apparaît dans ta campagne MyLead.',
        'Vérifie l’aperçu, coche la confirmation puis envoie. L’équipe vérifie l’offre avant de l’afficher.',
      ],
      figure: { title: 'Formulaire Publier', rows: ['Titre', 'Lien https://…', 'Description', 'Pays · Âge · Action', 'Aperçu puis Envoyer'], highlight: 4, note: 'Écran HAISSEL.' },
      internalView: { label: 'Ouvrir le formulaire Publier', view: 'publish' },
    },
    {
      title: 'Comprendre les statistiques, validations et refus',
      intro: 'Dans les statistiques MyLead, distingue les clics, les actions en attente et les actions validées : seules ces dernières sont payées.',
      instructions: [
        'Consulte régulièrement les statistiques de ta campagne dans le panneau MyLead.',
        'Une action « en attente » n’est pas encore gagnée : l’annonceur peut la refuser.',
        'Un refus signifie souvent que le contact ne respectait pas les conditions (pays, âge, fausse information).',
        'Beaucoup de refus ? Revois ta façon de promouvoir l’offre et relis les restrictions.',
        'Ne clique jamais sur ton propre lien et ne demande pas à tes proches de s’inscrire « pour aider » : c’est de la fraude.',
      ],
      figure: { title: 'Statistiques', rows: ['Clics', 'En attente', 'Validées', 'Refusées'], highlight: 2, note: 'Seules les actions validées sont payées.' },
    },
    {
      title: 'Promouvoir sans spam ni fausses promesses',
      intro: 'Une bonne promotion explique honnêtement l’offre à des personnes que cela peut vraiment intéresser.',
      instructions: [
        'Présente l’offre avec tes mots : ce qu’elle fait, ses limites, son prix éventuel.',
        'Indique toujours « lien affilié » ou « #publicité » à côté du lien.',
        'Ne promets jamais de gains et n’affirme pas qu’une inscription rapporte de l’argent si ce n’est pas le cas.',
        'N’envoie pas de messages en masse, ne publie pas dans des groupes qui l’interdisent.',
        'Respecte les canaux autorisés par la campagne.',
      ],
      figure: { title: 'Avant de publier', rows: ['✓ Honnête', '✓ « Lien affilié » visible', '✗ Spam', '✗ Promesse de gains'], highlight: -1, note: 'Voir aussi l’onglet Sécurité et légalité.' },
      internal: { label: 'Lire « Sécurité et légalité »', tab: 'safety' },
    },
  ];

  function h(tag, attrs, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'className') element.className = value;
      else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
      else element.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  /** Schéma d'écran de téléphone (SVG original). */
  function figure({ title, rows, highlight, note }) {
    const NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs, text) => {
      const node = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const rowHeight = 30;
    const height = 70 + rows.length * (rowHeight + 8) + 20;
    const svg = svgEl('svg', { viewBox: `0 0 220 ${height}`, role: 'img', 'aria-label': `Schéma : ${title}`, class: 'guide-figure-svg' });
    svg.append(
      svgEl('rect', { x: 4, y: 4, width: 212, height: height - 8, rx: 18, fill: '#ffffff', stroke: '#1c2529', 'stroke-width': 2 }),
      svgEl('rect', { x: 4, y: 4, width: 212, height: 44, rx: 18, fill: '#00473a' }),
      svgEl('rect', { x: 4, y: 30, width: 212, height: 18, fill: '#00473a' }),
      svgEl('text', { x: 110, y: 32, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 13, 'font-weight': 700 }, title)
    );
    rows.forEach((label, index) => {
      const y = 62 + index * (rowHeight + 8);
      const active = index === highlight;
      svg.append(
        svgEl('rect', { x: 18, y, width: 184, height: rowHeight, rx: 6, fill: active ? '#e3f3f0' : '#f6f8f9', stroke: active ? '#008673' : '#d8dee2', 'stroke-width': active ? 2.5 : 1 }),
        svgEl('text', { x: 28, y: y + 19, fill: active ? '#00513f' : '#1c2529', 'font-size': 11.5, 'font-weight': active ? 700 : 400 }, label)
      );
      if (active) svg.append(svgEl('text', { x: 194, y: y + 20, 'text-anchor': 'end', fill: '#008673', 'font-size': 14, 'font-weight': 700 }, '◀'));
    });
    return h('figure', { className: 'guide-figure' }, svg, h('figcaption', null, `Schéma indicatif. ${note}`));
  }

  function loadProgress() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return new Set(Array.isArray(value) ? value.filter((n) => Number.isInteger(n) && n >= 0 && n < STEPS.length) : []);
    } catch (error) {
      return new Set();
    }
  }

  function saveProgress(done) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...done]));
    } catch (error) { /* stockage indisponible : progression non conservée */ }
  }

  function externalButton(link) {
    return h('a', { className: 'secondary-button', href: link.href, target: '_blank', rel: 'noopener noreferrer' }, `${link.label} ↗`);
  }

  /**
   * Affiche le parcours dans `container`.
   * options : { referral, onOpenTab(tab), onOpenView(view) }
   */
  function render(container, options = {}) {
    const done = loadProgress();
    const progressBar = h('progress', { max: String(STEPS.length), value: String(done.size), className: 'guide-progress', 'aria-label': 'Progression du parcours' });
    const progressText = h('p', { className: 'guide-progress-text', 'aria-live': 'polite' });
    const updateProgress = () => {
      progressBar.value = done.size;
      progressText.textContent = done.size === STEPS.length
        ? 'Parcours terminé : bravo ! Tu peux le relire quand tu veux.'
        : `${done.size} étape${done.size > 1 ? 's' : ''} terminée${done.size > 1 ? 's' : ''} sur ${STEPS.length}`;
    };

    const items = STEPS.map((step, index) => {
      const button = h('button', { className: 'primary-button guide-done', type: 'button', 'aria-pressed': String(done.has(index)) });
      const details = h('details', { className: 'learn-card guide-step' });
      const badge = h('span', { className: 'guide-step-no', 'aria-hidden': 'true' });
      const status = h('span', { className: 'visually-hidden' });

      const sync = () => {
        const isDone = done.has(index);
        button.setAttribute('aria-pressed', String(isDone));
        button.textContent = isDone ? '✓ Étape terminée (annuler)' : 'J’ai terminé cette étape';
        details.classList.toggle('is-done', isDone);
        badge.textContent = isDone ? '✓' : String(index + 1);
        status.textContent = isDone ? ' (terminée)' : '';
      };
      button.addEventListener('click', () => {
        if (done.has(index)) done.delete(index);
        else {
          done.add(index);
          // Ouvre l'étape suivante pour enchaîner facilement sur téléphone.
          const next = items[index + 1];
          if (next) {
            details.open = false;
            next.open = true;
            next.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        saveProgress(done);
        sync();
        updateProgress();
      });

      const actions = [];
      for (const link of step.links || []) actions.push(externalButton(link));
      if (step.referral && options.referral?.available) {
        actions.push(h('a', { className: 'secondary-button', href: options.referral.url, target: '_blank', rel: 'sponsored noopener noreferrer' }, 'S’inscrire avec le lien de parrainage ↗'));
      }
      if (step.internal && options.onOpenTab) {
        actions.push(h('button', { className: 'secondary-button', type: 'button', onclick: () => options.onOpenTab(step.internal.tab) }, step.internal.label));
      }
      if (step.internalView && options.onOpenView) {
        actions.push(h('button', { className: 'secondary-button', type: 'button', onclick: () => options.onOpenView(step.internalView.view) }, step.internalView.label));
      }

      details.append(
        h('summary', null, badge, h('span', { className: 'learn-card-title' }, step.title, status)),
        h('div', { className: 'learn-card-body guide-step-body' },
          h('p', null, step.intro),
          step.warning ? h('p', { className: 'guide-warning', role: 'note' }, step.warning) : null,
          h('ol', { className: 'learn-points' }, step.instructions.map((line) => h('li', null, line))),
          step.checklist ? h('fieldset', { className: 'guide-checklist' },
            h('legend', null, 'Ma vérification (pour moi seulement)'),
            step.checklist.map((label) => h('label', { className: 'show-password' }, h('input', { type: 'checkbox' }), h('span', null, label)))) : null,
          figure(step.figure),
          step.referral ? h('p', { className: 'security-note' }, options.referral?.available
            ? 'Le lien de parrainage est celui de l’éditeur de HAISSEL : il peut recevoir une part de tes futurs gains, versée par MyLead, sans réduire les tiens. Le lien d’inscription direct fonctionne aussi.'
            : 'Inscris-toi avec le lien officiel ci-dessus.') : null,
          actions.length ? h('div', { className: 'guide-actions' }, actions) : null,
          h('p', { className: 'security-note' }, 'L’interface de MyLead peut évoluer : si un libellé est différent, cherche l’intitulé le plus proche ou consulte le guide officiel.'),
          button));
      sync();
      return details;
    });

    updateProgress();
    container.replaceChildren(
      h('div', { className: 'profile-card-box guide-head' },
        h('h3', { className: 'card-title' }, 'Débuter sur MyLead, pas à pas'),
        h('p', null, 'Tout se fait depuis ton téléphone, sans aucune connaissance technique. Coche chaque étape quand elle est faite : ta progression reste enregistrée dans ce navigateur uniquement.'),
        h('p', { className: 'ad-notice' }, 'Les revenus ne sont jamais garantis. MyLead et les annonceurs décident seuls de valider ou non chaque action. HAISSEL n’est pas MyLead et n’approuve pas les campagnes.'),
        progressBar,
        progressText),
      ...items);
  }

  /** Progression enregistrée dans ce navigateur (carte « Apprendre » de l'accueil). */
  function progress() {
    return { done: loadProgress().size, total: STEPS.length };
  }

  /*
   * Bandeau « Apprendre » de l'accueil : le choix de le masquer reste dans
   * ce navigateur. Stockage indisponible : le bandeau reste visible.
   */
  const BANNER_KEY = 'haissel_learn_banner_hidden';
  function bannerHidden() {
    try {
      return localStorage.getItem(BANNER_KEY) === '1';
    } catch (error) {
      return false;
    }
  }
  function hideBanner() {
    try {
      localStorage.setItem(BANNER_KEY, '1');
    } catch (error) { /* stockage indisponible : masqué pour cette visite seulement */ }
  }

  window.HaisselMyLeadGuide = { render, progress, bannerHidden, hideBanner, STEPS };
}());
