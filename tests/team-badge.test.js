/*
 * Mini ours « Équipe HAISSEL » : seulement sur les publications d'un compte
 * ADMIN, d'après le rôle de l'auteur lu en base (jamais un champ du client).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const helpers = require('./helpers/setup');

const { app } = require('../src/app');

const { createUser, login, auth } = helpers;
const APP_JS = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../frontend/app-v2.css'), 'utf8');

const fnSource = (name) => {
  const start = APP_JS.indexOf(`function ${name}(`);
  return APP_JS.slice(start, APP_JS.indexOf('\n}\n', start) + 2);
};

let pool;
let member;
let adminOfferId;
let memberOfferId;

async function insertOffer(userId, kind, title, extra = '') {
  const { rows } = await pool.query(
    `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                                rights_confirmed_at, status, published_at, kind, min_age, campaign_name)
     VALUES ($1, $2, 'https://example.org/offre', 'Une description assez longue pour passer.', 'applications', 'FR',
             'S’inscrire sur le site', NOW(), 'published', NOW(), $3, ${kind === 'affiliate' ? 13 : 'NULL'}, $4)
     RETURNING id`,
    [userId, title, kind, kind === 'campaign' ? `Campagne ${extra}` : null]
  );
  return rows[0].id;
}

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  const adminUser = await createUser({ admin: true, prefix: 'teamadmin' });
  const memberUser = await createUser({ prefix: 'teammember', adult: true });
  member = await login(app, memberUser);
  adminOfferId = await insertOffer(adminUser.id, 'affiliate', 'Offre de l’équipe');
  memberOfferId = await insertOffer(memberUser.id, 'campaign', 'Fiche d’un membre', 'X');
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

describe('serveur : from_team', () => {
  test('vrai pour l’offre d’un ADMIN, faux pour celle d’un membre', async () => {
    const res = await request(app).get('/api/community/offers').set(auth(member));
    const byId = Object.fromEntries(res.body.data.items.map((o) => [o.id, o]));
    expect(byId[adminOfferId].from_team).toBe(true);
    expect(byId[memberOfferId].from_team).toBe(false);
  });

  test('un champ envoyé par le client ne compte pas', async () => {
    const res = await request(app).post('/api/community/offers').set(auth(member)).send({
      title: 'Fiche qui se dit de l’équipe', url: 'https://example.org/officiel', category: 'applications',
      description: 'Une description assez longue pour être acceptée.', countries: 'FR',
      expected_action: 'S’inscrire sur le site', campaign_name: 'Campagne test', rights_confirmed: true,
      from_team: true, author: { is_team: true }, author_is_team: true,
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.offer.from_team).toBe(false);
  });
});

describe('front : teamBadge', () => {
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat().filter((c) => c !== null && c !== undefined) });
  const sandbox = { h };
  vm.runInNewContext(`${fnSource('teamBadge')}; this.teamBadge = teamBadge;`, sandbox);

  test('ours seulement si from_team === true', () => {
    expect(sandbox.teamBadge({ from_team: false })).toBeNull();
    expect(sandbox.teamBadge({})).toBeNull();
    expect(sandbox.teamBadge({ from_team: 'true' })).toBeNull();
    const badge = sandbox.teamBadge({ from_team: true });
    const [img, label] = badge.children;
    expect(img.tag).toBe('img');
    expect(img.attrs.src).toBe('/images/mascotte/avatar-equipe-128.webp');
    expect(img.attrs.alt).toBe('Équipe HAISSEL');
    expect(img.attrs.width).toBe(18);
    // Texte visible masqué aux lecteurs d'écran : pas de doublon avec l'alt.
    expect(label.attrs['aria-hidden']).toBe('true');
    expect(label.children).toEqual(['Équipe HAISSEL']);
  });

  test('premier de la rangée de badges : carte du fil, carte de liste et page détail', () => {
    for (const fn of ['postCard', 'communityCard']) {
      expect([fn, fnSource(fn).includes('teamBadge(offer), kindBadge(offer)')]).toEqual([fn, true]);
    }
    const detail = fnSource('offerDetail');
    expect(detail.indexOf('teamBadge(offer)')).toBeGreaterThan(-1);
    expect(detail.indexOf('teamBadge(offer)')).toBeLessThan(detail.indexOf('kindBadge(offer)'));
  });

  test('18 px, rond, sans bordure', () => {
    expect(CSS).toMatch(/\.team-pill-avatar \{[^}]*width: 18px; height: 18px;[^}]*border: 0; border-radius: 50%/);
  });
});
