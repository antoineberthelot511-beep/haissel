/*
 * Découvrir sur iPhone (WebKit, émulation iPhone 13, tactile) : boutons
 * atteignables, défilement vertical, Infos / Visiter, double tap = Enregistrer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4317);
const STATE_FILE = path.join(os.tmpdir(), `haissel-e2e-${PORT}.json`);

async function openDiscover(page) {
  const { username, password } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const res = await page.request.post('/api/auth/login', { data: { identifier: username, password } });
  expect(res.status()).toBe(200);
  await page.goto('/app#decouvrir');
  await expect(page.locator('#discover-feed .discover-slide[data-offer-id]')).toHaveCount(4, { timeout: 20000 });
  await page.evaluate(() => document.getElementById('boot-screen')?.remove());
}

/* Ce qu'il y a vraiment sous le doigt, au centre d'un élément. */
async function hitAt(page, locator) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return page.evaluate(([px, py, selector]) => {
    const expected = document.querySelector(selector);
    const hit = document.elementFromPoint(px, py);
    const describe = (n) => (n ? `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${n.className && typeof n.className === 'string' ? `.${n.className.trim().split(/\s+/).join('.')}` : ''}` : 'null');
    return { ok: Boolean(hit && expected && (hit === expected || expected.contains(hit))), hit: describe(hit), x: px, y: py };
  }, [x, y, await locator.evaluate((el) => {
    el.setAttribute('data-e2e-target', '1');
    return '[data-e2e-target="1"]';
  })]).finally(() => locator.evaluate((el) => el.removeAttribute('data-e2e-target')));
}

const slide = (page, i = 0) => page.locator('#discover-feed .discover-slide[data-offer-id]').nth(i);

/* Amène la slide i à l'écran (comme après un glissement). */
async function showSlide(page, i) {
  await page.locator('#discover-feed').evaluate((el, index) => { el.scrollTop = index * el.clientHeight; }, i);
  await expect.poll(() => page.locator('#discover-feed').evaluate((el) => Math.round(el.scrollTop / el.clientHeight))).toBe(i);
}

test.describe('Découvrir sur iPhone', () => {
  test.beforeEach(async ({ page }) => { await openDiscover(page); });

  test('boutons et slide atteignables (elementFromPoint)', async ({ page }) => {
    const first = slide(page);
    const targets = {
      Enregistrer: first.locator('.discover-actions .save-button'),
      Infos: first.getByRole('button', { name: /^Infos sur/ }),
      Visiter: first.getByRole('button', { name: /^Visiter le site/ }),
      '⋯': first.getByRole('button', { name: /^Plus d’options/ }),
      légende: first.locator('.discover-caption'),
      slide: first,
    };
    const report = {};
    for (const [name, locator] of Object.entries(targets)) report[name] = await hitAt(page, locator);
    console.log('elementFromPoint :', JSON.stringify(report, null, 1));
    for (const [name, r] of Object.entries(report)) expect([name, r.ok, r.hit]).toEqual([name, true, expect.any(String)]);
  });

  test('défilement vertical : la slide suivante arrive', async ({ page }) => {
    const feed = page.locator('#discover-feed');
    const touchAction = await feed.evaluate((el) => {
      const chain = [];
      for (let n = el; n; n = n.parentElement) chain.push(`${n.id || n.tagName.toLowerCase()}:${getComputedStyle(n).touchAction}`);
      return chain;
    });
    console.log('touch-action de .discover-feed vers la racine :', touchAction.join(' > '));
    // Aucun ancêtre ne doit restreindre le défilement natif du fil.
    expect(touchAction.filter((entry) => !/:(auto|manipulation|pan-y)$/.test(entry) && !/^discover-feed:/.test(entry))).toEqual([]);
    // Plus aucun touch-action restrictif sur #main (cause de la régression).
    expect(touchAction).toContain('main:auto');
    /*
     * Playwright WebKit mobile n'a ni glissement tactile ni molette : on vérifie
     * ce qui rend le défilement natif possible (fil défilant, aimanté, sans
     * transformation), puis qu'un défilement s'arrête bien sur la slide suivante.
     */
    const props = await feed.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY, snap: getComputedStyle(el).scrollSnapType,
      scrollable: el.scrollHeight > el.clientHeight * 3, transform: el.style.transform,
      slideTouch: getComputedStyle(el.querySelector('.discover-slide')).touchAction,
    }));
    expect(props).toEqual({ overflowY: 'auto', snap: 'y mandatory', scrollable: true, transform: '', slideTouch: 'manipulation' });
    const box = await feed.boundingBox();
    await feed.evaluate((el, dy) => el.scrollBy({ top: dy, behavior: 'instant' }), box.height * 0.6);
    await expect.poll(() => feed.evaluate((el) => Math.round(el.scrollTop / el.clientHeight))).toBe(1);
  });

  test('tap sur Infos : feuille Description ; tap sur Visiter : confirmation de sortie', async ({ page }) => {
    await slide(page).getByRole('button', { name: /^Infos sur/ }).tap();
    await expect(page.locator('#discover-sheet')).toHaveAttribute('open', '');
    await page.locator('#discover-sheet [data-close-sheet], #discover-sheet').first().press('Escape');
    await expect(page.locator('#discover-sheet')).not.toHaveAttribute('open', '');
    await slide(page).getByRole('button', { name: /^Visiter le site/ }).tap();
    await expect(page.locator('#leave-dialog')).toHaveAttribute('open', '');
  });

  test('tap sur ⋯ : menu Plus d’options', async ({ page }) => {
    await slide(page).getByRole('button', { name: /^Plus d’options/ }).tap();
    await expect(page.locator('#discover-more-sheet')).toHaveAttribute('open', '');
  });

  test('tap sur le nom de l’auteur : profil du membre', async ({ page }) => {
    await slide(page).locator('.discover-who .post-author').tap();
    await expect(page.locator('#member-dialog')).toHaveAttribute('open', '');
  });

  test('feuille fermée : plus rien d’ouvert ni d’inerte, les taps remarchent', async ({ page }) => {
    await slide(page).getByRole('button', { name: /^Infos sur/ }).tap();
    await expect(page.locator('#discover-sheet')).toHaveAttribute('open', '');
    await page.locator('#discover-sheet').press('Escape');
    await expect(page.locator('#discover-sheet')).not.toHaveAttribute('open', '');
    expect(await page.evaluate(() => [...document.querySelectorAll('[inert]')].filter((n) => n.closest('#discover-feed') || n.contains(document.getElementById('discover-feed'))).length)).toBe(0);
    await slide(page).getByRole('button', { name: /^Plus d’options/ }).tap();
    await expect(page.locator('#discover-more-sheet')).toHaveAttribute('open', '');
  });

  test('page de dessous bloquée en Découvrir', async ({ page }) => {
    expect(await page.evaluate(() => [getComputedStyle(document.documentElement).overflowY, getComputedStyle(document.body).overflowY])).toEqual(['hidden', 'hidden']);
  });

  test('tap sur la légende : feuille Description', async ({ page }) => {
    await slide(page).locator('.discover-caption').tap();
    await expect(page.locator('#discover-sheet')).toHaveAttribute('open', '');
  });

  test('double tap sur le fond : enregistrée, et un 2e double tap ne désenregistre pas', async ({ page }) => {
    const first = slide(page);
    const save = first.locator('.discover-actions .save-button');
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    const box = await first.boundingBox();
    const point = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.3 };
    await page.touchscreen.tap(point.x, point.y);
    await page.touchscreen.tap(point.x, point.y);
    await expect(save).toHaveAttribute('aria-pressed', 'true');
    await expect(save).toHaveAttribute('aria-label', 'Enregistré');
    // Grand signet sans bloquer les touchers, retiré du DOM après l'animation.
    expect(await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'discover-burst';
      document.body.append(probe);
      const value = getComputedStyle(probe).pointerEvents;
      probe.remove();
      return value;
    })).toBe('none');
    await expect(page.locator('.discover-burst')).toHaveCount(0, { timeout: 2000 });
    await page.touchscreen.tap(point.x, point.y);
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForTimeout(400);
    await expect(save).toHaveAttribute('aria-pressed', 'true');
  });

  test('simple tap sur le fond : rien', async ({ page }) => {
    await showSlide(page, 1);
    const first = slide(page, 1);
    const box = await first.boundingBox();
    await page.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.3);
    await page.waitForTimeout(450);
    await expect(first.locator('.discover-actions .save-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#discover-sheet')).not.toHaveAttribute('open', '');
  });

  test('double tap sur un bouton ou une pastille : pas d’enregistrement', async ({ page }) => {
    await showSlide(page, 2);
    const first = slide(page, 2);
    // Pastilles (zone exclue).
    const badges = await first.locator('.discover-badges').boundingBox();
    await page.touchscreen.tap(badges.x + 5, badges.y + badges.height / 2);
    await page.touchscreen.tap(badges.x + 5, badges.y + badges.height / 2);
    // Bouton Infos : il ouvre la feuille, rien n'est enregistré.
    const infos = await first.getByRole('button', { name: /^Infos sur/ }).boundingBox();
    await page.touchscreen.tap(infos.x + infos.width / 2, infos.y + infos.height / 2);
    await page.touchscreen.tap(infos.x + infos.width / 2, infos.y + infos.height / 2);
    await page.waitForTimeout(400);
    await expect(first.locator('.discover-actions .save-button')).toHaveAttribute('aria-pressed', 'false');
  });

  test('double tap sur une slide : enregistrée, aucun zoom', async ({ page }) => {
    await showSlide(page, 3);
    const s = slide(page, 3);
    const save = s.locator('.discover-actions .save-button');
    const box = await s.boundingBox();
    const p = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.3 };
    await page.touchscreen.tap(p.x, p.y);
    await page.touchscreen.tap(p.x, p.y);
    await expect(save).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
  });

  test('2 taps rapides sur Infos puis fermeture : pas de zoom, fil immobile, taps toujours OK', async ({ page }) => {
    await showSlide(page, 1);
    const feed = page.locator('#discover-feed');
    const before = await feed.evaluate((el) => el.scrollTop);
    const infos = await slide(page, 1).getByRole('button', { name: /^Infos sur/ }).boundingBox();
    const cx = infos.x + infos.width / 2;
    const cy = infos.y + infos.height / 2;
    await page.touchscreen.tap(cx, cy);
    await page.touchscreen.tap(cx, cy);
    await expect(page.locator('#discover-sheet')).toHaveAttribute('open', '');
    await page.locator('#discover-sheet').press('Escape');
    await expect(page.locator('#discover-sheet')).not.toHaveAttribute('open', '');
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const feedEl = document.getElementById('discover-feed');
      const ancestors = [];
      for (let n = feedEl.parentElement; n; n = n.parentElement) {
        if (n.inert || getComputedStyle(n).transform !== 'none') ancestors.push(n.id || n.tagName);
      }
      return { scale: window.visualViewport.scale, top: feedEl.scrollTop, doc: document.scrollingElement.scrollTop, ancestors };
    });
    expect(after).toEqual({ scale: 1, top: before, doc: 0, ancestors: [] });
    // ⋯ : ouverture et fermeture sans décalage non plus.
    await slide(page, 1).getByRole('button', { name: /^Plus d’options/ }).tap();
    await expect(page.locator('#discover-more-sheet')).toHaveAttribute('open', '');
    await page.locator('#discover-more-sheet').press('Escape');
    await expect(page.locator('#discover-more-sheet')).not.toHaveAttribute('open', '');
    await page.waitForTimeout(700);
    expect(await feed.evaluate((el) => el.scrollTop)).toBe(before);
    await slide(page, 1).locator('.discover-who .post-author').tap();
    await expect(page.locator('#member-dialog')).toHaveAttribute('open', '');
  });

  test('Enregistrer : le fil n’est pas re-rendu (même nœud de slide)', async ({ page }) => {
    await page.evaluate(() => { window.__slide = document.querySelector('#discover-feed .discover-slide[data-offer-id]'); });
    const save = slide(page).locator('.discover-actions .save-button');
    const was = await save.getAttribute('aria-pressed');
    await save.tap();
    await expect(save).toHaveAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
    expect(await page.evaluate(() => window.__slide === document.querySelector('#discover-feed .discover-slide[data-offer-id]') && window.__slide.isConnected)).toBe(true);
  });
});
