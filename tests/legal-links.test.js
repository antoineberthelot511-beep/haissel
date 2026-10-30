/*
 * Liens légaux : plus de pied de page dans l'espace membre (Profil → Réglages
 * → À propos), une ligne compacte sur les pages publiques, et aucun lien
 * cassé vers les pages légales.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');

afterAll(() => app.pool.end());

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const LEGAL = ['mentions-legales.html', 'transparence.html', 'confidentialite.html', 'cgu.html'];
const html = read('index.html');
const css = read('app-v2.css');

describe('espace membre', () => {
  test('le pied de page est masqué une fois connecté, sans « espace membre »', () => {
    expect(css).toMatch(/body:has\(#app-screen:not\(\.hidden\)\) \.site-footer \{ display: none; \}/);
    const footer = html.slice(html.indexOf('<footer class="site-footer">'), html.indexOf('</footer>'));
    expect(footer).not.toMatch(/espace membre/i);
    for (const page of LEGAL) expect(footer).toContain(`href="${page}"`);
  });

  test('Réglages → À propos : une ligne par page légale, avec chevron', () => {
    const settings = html.slice(html.indexOf('id="ppanel-settings"'), html.indexOf('id="howto-sheet"'));
    const rows = settings.match(/<a class="about-row" href="[^"]+">[^<]+<svg[^>]*><use href="#i-chevron-right" \/><\/svg><\/a>/g) || [];
    expect(rows.map((row) => row.match(/href="([^"]+)"/)[1])).toEqual([...LEGAL, '/contact']);
    expect(settings).toContain("Conditions d'utilisation");
    expect(settings).toContain('class="about-meta">HAISSEL');
    expect(css).toMatch(/\.about-row \{[^}]*min-height: 44px/);
  });
});

describe('pages légales', () => {
  test.each(LEGAL)('%s est servie (200, HTML)', async (page) => {
    const res = await request(app).get(`/${page}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('aucun lien relatif cassé (index.html et pages légales)', () => {
    for (const name of ['index.html', ...LEGAL]) {
      const hrefs = [...read(name).matchAll(/href="([^"#:]+\.(?:html|css))"/g)].map((m) => m[1]);
      for (const href of hrefs) expect([name, href, fs.existsSync(path.join(FRONTEND, href))]).toEqual([name, href, true]);
    }
  });
});
