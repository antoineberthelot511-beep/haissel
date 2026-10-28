/*
 * Pages légales : structure (retour, logo, sommaire, liens compacts),
 * contenu fidèle au fonctionnement de l'app, aucune donnée personnelle,
 * et aucun débordement horizontal à 375 px (Playwright, si Chromium est
 * installé : npx playwright install chromium).
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const FRONTEND = path.join(__dirname, '../frontend');
const PAGES = ['cgu.html', 'confidentialite.html', 'mentions-legales.html', 'transparence.html'];
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe.each(PAGES)('%s', (page) => {
  const html = read(page);

  test('en-tête : retour vers /app, logo, titre, date de mise à jour', () => {
    expect(html).toMatch(/<a class="legal-back" href="\/app" data-legal-back>‹ Retour<\/a>/);
    expect(html).toContain('<img src="/logo.svg" alt=""');
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html).toMatch(/<p class="updated">Dernière mise à jour : \d{1,2} [a-zéû]+ \d{4}<\/p>/);
    expect(html).toContain('<script src="/legal.js"></script>');
  });

  test('sommaire : chaque ancre mène à une section de la page', () => {
    const toc = html.slice(html.indexOf('class="toc"'), html.indexOf('</nav>'));
    const anchors = [...toc.matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(3);
    for (const id of anchors) expect([id, html.includes(`<h2 id="${id}">`)]).toEqual([id, true]);
  });

  test('pied : seulement la ligne compacte des liens légaux, tous valides', () => {
    const links = html.slice(html.indexOf('class="legal-links"'));
    for (const target of PAGES) {
      expect(links).toContain(`href="${target}"`);
      expect(fs.existsSync(path.join(FRONTEND, target))).toBe(true);
    }
    expect(links).toContain(`href="${page}" aria-current="page"`);
    expect(html).not.toContain('<footer');
    for (const [, href] of html.matchAll(/href="([a-z-]+\.html)(?:#[a-z-]+)?"/g)) {
      expect([href, fs.existsSync(path.join(FRONTEND, href))]).toEqual([href, true]);
    }
  });

  test('aucune donnée personnelle dans le code', () => {
    expect(html).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(html).not.toMatch(/gmail|Berthelot/i);
    expect(html).not.toMatch(/(?:\+33|0)[1-9](?:[ .-]?\d{2}){4}/);
  });
});

describe('contenu', () => {
  test('confidentialité : durées réellement appliquées (retention.service.js)', () => {
    const page = text(read('confidentialite.html'));
    expect(read('confidentialite.html')).toContain('<h2 id="durees">');
    expect(page).toMatch(/12 mois après le dernier message échangé/);
    expect(page).toMatch(/Journal de sécurité.*12 mois/);
    expect(page).toMatch(/IP, navigateur et page d’origine effacés après 6 mois/);
    expect(page).toMatch(/1 jour après le dernier échec/);
    const retention = fs.readFileSync(path.join(__dirname, '../src/services/retention.service.js'), 'utf8');
    expect(retention).toMatch(/INTERVAL '6 months'/);
    expect(retention).toMatch(/security_events WHERE created_at < NOW\(\) - INTERVAL '12 months'/);
    expect(retention).toMatch(/last_message_at < NOW\(\) - INTERVAL '12 months'/);
  });

  test('confidentialité : prestataires, droits RGPD, CNIL', () => {
    const html = read('confidentialite.html');
    expect(html).toContain('<h2 id="prestataires">Prestataires</h2>');
    const page = text(html);
    for (const name of ['Vercel', 'Neon', 'Cloudflare', 'Turnstile', 'Apple', 'Google', 'Mozilla', 'Microsoft']) {
      expect([name, page.includes(name)]).toEqual([name, true]);
    }
    for (const right of ['accès', 'rectification', 'suppression', 'opposition']) expect(page).toContain(right);
    expect(page).toContain('CNIL');
  });

  test('CGU : règles appliquées par le code', () => {
    const page = text(read('cgu.html'));
    const community = fs.readFileSync(path.join(__dirname, '../src/controllers/community.controller.js'), 'utf8');
    expect(community).toContain('const STORY_HOURS = 24;');
    expect(community).toContain('const RENEW_COOLDOWN_HOURS = 20;');
    expect(page).toMatch(/visible 24 heures/);
    expect(page).toMatch(/20 heures/);
    expect(fs.readFileSync(path.join(__dirname, '../src/services/adult.service.js'), 'utf8')).toContain('const ADULT_UPGRADE_DELAY_DAYS = 30;');
    expect(page).toMatch(/30 jours/);
    for (const rule of ['Auto-clics', 'Faux comptes', 'Échanges d\'inscriptions', "messagerie te permet d'écrire", 'facultatifs', 'suspendre']) {
      expect([rule, page.includes(rule)]).toEqual([rule, true]);
    }
    expect(page).toMatch(/liens affiliés sont réservés à l'équipe HAISSEL/);
  });

  test('plus aucun repère [À …] dans frontend/', () => {
    const files = fs.readdirSync(FRONTEND).filter((name) => /\.(html|js|css)$/.test(name));
    for (const name of files) {
      expect([name, read(name).match(/\[À [^\]]*\]/g)]).toEqual([name, null]);
    }
    for (const page of [...PAGES, 'contact.html']) expect(read(page)).not.toMatch(/À COMPLÉTER|À VALIDER|À VÉRIFIER|médiateur/);
    expect(read('mentions-legales.html')).toContain('Contact : <a href="https://vercel.com/help" rel="noopener noreferrer">https://vercel.com/help</a>.');
  });

  test('double authentification : aucune mention destinée aux membres', () => {
    expect(read('cgu.html')).not.toMatch(/double authentification/i);
    expect(read('confidentialite.html')).toContain('double authentification obligatoire pour les administrateurs');
    expect(read('confidentialite.html')).not.toMatch(/si tu l’actives<\/td>/);
  });

  test('éditeur non professionnel, hébergeur, serveurs en Europe, contact par formulaire', () => {
    const mentions = read('mentions-legales.html');
    expect(mentions).toContain("HAISSEL est édité par une personne physique à titre non professionnel. Conformément à l'article 6 III-2 de la loi n° 2004-575 du 21 juin 2004, son identité a été communiquée à l'hébergeur.");
    expect(mentions).not.toMatch(/SIRET|directeur de la publication|adresse postale/i);
    expect(mentions).toContain('<strong>Vercel Inc.</strong>, 440 N Barranca Ave #4133, Covina, CA 91723');
    const privacy = read('confidentialite.html');
    expect(privacy).toContain("Les données sont hébergées et traitées dans l'Union européenne (Francfort, Allemagne) par Vercel et Neon.");
    expect(privacy).toContain(`Responsable du traitement : l'éditeur de HAISSEL, joignable via le <a href="/contact">`);
    expect(privacy).toMatch(/Data Privacy Framework/);
    expect(privacy).toMatch(/formulaire de contact[^<]*<\/td><td[^>]*>[^<]*<\/td><td[^>]*>[^<]*<\/td><td[^>]*>12 mois/);
    expect(privacy).toMatch(/date et l'heure de cette acceptation sont enregistrées/);
    for (const page of [...PAGES, 'contact.html']) {
      expect(read(page)).not.toMatch(/adresse e-mail de contact/);
      expect(read(page)).toContain('<a href="/contact"');
      if (page !== 'contact.html') expect(read(page)).toContain('Dernière mise à jour : 27 octobre 2026');
    }
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
    expect(vercel.regions).toEqual(['fra1']);
    expect(vercel.builds).toHaveLength(1);
  });
});

/* Débordement horizontal à 375 px, dans un vrai navigateur. */
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (error) { chromium = null; }

describe('affichage à 375 px (Playwright)', () => {
  let server;
  let browser;
  let base;

  beforeAll(async () => {
    if (!chromium) return;
    try { browser = await chromium.launch(); } catch (error) { browser = null; return; }
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
    server = http.createServer((req, res) => {
      const file = path.join(FRONTEND, decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(FRONTEND)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => { server.close(resolve); });
  });

  test.each(PAGES)('%s : pas de défilement horizontal, texte ≥ 16 px', async (page) => {
    if (!browser) return; // Chromium absent : vérification ignorée (npx playwright install chromium).
    for (const colorScheme of ['light', 'dark']) {
      const tab = await browser.newPage({ viewport: { width: 375, height: 812 }, colorScheme });
      await tab.goto(`${base}/${page}`);
      const metrics = await tab.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: parseFloat(getComputedStyle(document.body).fontSize),
        lineHeight: parseFloat(getComputedStyle(document.body).lineHeight) / parseFloat(getComputedStyle(document.body).fontSize),
      }));
      await tab.close();
      expect([page, colorScheme, metrics.overflow]).toEqual([page, colorScheme, 0]);
      expect(metrics.body).toBeGreaterThanOrEqual(16);
      expect(metrics.lineHeight).toBeGreaterThanOrEqual(1.6);
    }
  }, 30000);
});
