/*
 * Logo HAISSEL : icônes d'app, favicons, logo dans l'interface, badge des
 * notifications. Plus aucun carré « H ».
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const exists = (name) => fs.existsSync(path.join(FRONTEND, name));
const PAGES = ['index.html', 'admin.html', 'cgu.html', 'confidentialite.html', 'mentions-legales.html', 'transparence.html'];

test('fichiers servis en local', () => {
  for (const file of ['logo.svg', 'favicon.svg', 'favicon-32.png', 'favicon-16.png', 'icons/icon-192.png', 'icons/icon-512.png',
    'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png', 'icons/badge-96.png']) {
    expect([file, exists(file)]).toEqual([file, true]);
  }
});

test.each(PAGES)('%s : favicons SVG, 32 et 16 px', (page) => {
  const html = read(page);
  expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  expect(html).toContain('<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />');
  expect(html).toContain('<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png" />');
});

test('plus de carré « H » : le logo est une image locale', () => {
  for (const page of ['index.html', 'admin.html']) {
    const html = read(page);
    expect(html).not.toMatch(/class="(wordmark-logo|splash-logo|msg-avatar|brand-mark)[^"]*"[^>]*>H</);
  }
  const index = read('index.html');
  for (const cls of ['wordmark-logo', 'wordmark-logo auth-logo', 'splash-logo']) {
    expect(index).toMatch(new RegExp(`<img class="${cls}" src="/logo.svg" alt=""`));
  }
  // Avatar de l'équipe : l'ours (rond), plus le logo « H ».
  for (const cls of ['msg-avatar sm team-avatar']) {
    expect(index).toMatch(new RegExp(`<img class="${cls}" src="/images/mascotte/avatar-equipe-128.webp" alt="Équipe Haissel"`));
  }
  expect(index).not.toMatch(/class="msg-[a-z-]*avatar[^"]*" src="\/logo.svg"/);
  expect(read('admin.html')).toMatch(/<img class="brand-mark" src="\/logo.svg" alt=""/);
});

test('manifeste : maskable séparée, couleur du logo', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  expect(manifest.theme_color).toBe('#0B57FF');
  const bySrc = Object.fromEntries(manifest.icons.map((icon) => [icon.src, icon.purpose]));
  expect(bySrc).toEqual({
    '/icons/icon-192.png': 'any', '/icons/icon-512.png': 'any', '/icons/icon-maskable-512.png': 'maskable',
  });
  expect(read('index.html')).toContain('<meta name="theme-color" content="#0B57FF" />');
});

test('notifications : badge monochrome, icône 192', () => {
  for (const file of ['sw.js', 'notifications.js']) {
    const source = read(file);
    expect(source).toContain("badge: '/icons/badge-96.png'");
    expect(source).toContain("icon: '/icons/icon-192.png'");
  }
});
