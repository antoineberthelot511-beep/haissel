/*
 * La connexion admin passe par POST /api/auth/login, protégé par
 * requireTurnstile('login') : sans widget sur /admin, aucun administrateur
 * ne peut se connecter quand Turnstile est configuré.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../frontend/admin.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../frontend/admin.js'), 'utf8');

describe('Turnstile sur la connexion admin', () => {
  test('admin.html contient un emplacement login dans le formulaire de connexion', () => {
    const form = html.match(/<form id="login-form"[\s\S]*?<\/form>/);
    expect(form).not.toBeNull();
    expect(form[0]).toMatch(/data-turnstile-action="login"/);
  });

  test('admin.html charge turnstile.js avant admin.js', () => {
    const turnstile = html.search(/<script src="\/?turnstile\.js"><\/script>/);
    expect(turnstile).toBeGreaterThan(-1);
    expect(turnstile).toBeLessThan(html.indexOf('admin.js"></script>'));
  });

  test('admin.js envoie le jeton et initialise le widget', () => {
    expect(js).toMatch(/cf_turnstile_response/);
    expect(js).toMatch(/HaisselTurnstile\.init\(/);
  });
});
