/*
 * Messagerie membre ↔ équipe : cloisonnement, admin, limite de débit,
 * rétention. PostgreSQL réel (schéma isolé).
 */
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const { purgeExpiredData } = require('../src/services/retention.service');
const { MEMBER_MESSAGES_PER_HOUR } = require('../src/controllers/messages.controller');

const { createUser, login, auth } = helpers;

let pool;
let admin;
let alice;
let bob;
let aliceUser;
let bobUser;

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  admin = await login(app, await createUser({ admin: true, prefix: 'msgadmin' }));
  aliceUser = await createUser({ prefix: 'msgalice' });
  bobUser = await createUser({ prefix: 'msgbob' });
  alice = await login(app, aliceUser);
  bob = await login(app, bobUser);
}, 30000);

afterAll(async () => {
  await helpers.teardownDatabase();
});

const send = (identity, body) => request(app).post('/api/messages/team').set(auth(identity)).send(body);
const conversationOf = async (userId) => (await pool.query('SELECT id FROM conversations WHERE member_id = $1', [userId])).rows[0]?.id;

describe('membre', () => {
  test('écrit à l’équipe et ne lit que sa propre conversation', async () => {
    expect((await send(alice, { content: 'Bonjour, une question sur une fiche.' })).status).toBe(201);
    expect((await send(bob, { content: 'Message de Bob, privé.' })).status).toBe(201);

    const res = await request(app).get('/api/messages/team').set(auth(alice));
    expect(res.status).toBe(200);
    const contents = res.body.data.messages.map((m) => m.content);
    expect(contents).toContain('Bonjour, une question sur une fiche.');
    expect(contents).not.toContain('Message de Bob, privé.');
  });

  test('ne peut pas écrire à un autre membre : tout destinataire est ignoré', async () => {
    const bobConversation = await conversationOf(bobUser.id);
    const res = await send(alice, { content: 'Tentative vers Bob', conversation_id: bobConversation, recipient_id: bobUser.id, to: bobUser.username });
    expect(res.status).toBe(201);
    const inBob = await pool.query('SELECT 1 FROM messages WHERE conversation_id = $1 AND content = $2', [bobConversation, 'Tentative vers Bob']);
    expect(inBob.rows).toHaveLength(0);
    const inAlice = await pool.query('SELECT 1 FROM messages WHERE conversation_id = $1 AND content = $2', [await conversationOf(aliceUser.id), 'Tentative vers Bob']);
    expect(inAlice.rows).toHaveLength(1);
  });

  test('n’a pas accès aux routes de l’équipe', async () => {
    const bobConversation = await conversationOf(bobUser.id);
    expect((await request(app).get('/api/admin/messages').set(auth(alice))).status).toBe(403);
    expect((await request(app).get(`/api/admin/messages/${bobConversation}`).set(auth(alice))).status).toBe(403);
    expect((await request(app).post(`/api/admin/messages/${bobConversation}`).set(auth(alice)).send({ content: 'x' })).status).toBe(403);
  });

  test('texte vide ou trop long refusé', async () => {
    expect((await send(alice, { content: '   ' })).status).toBe(400);
    expect((await send(alice, { content: 'a'.repeat(2001) })).status).toBe(400);
  });

  test('sans session : refusé', async () => {
    expect((await request(app).get('/api/messages/team')).status).toBe(401);
  });
});

describe('équipe', () => {
  test('un admin voit toutes les conversations, non lues d’abord, et répond', async () => {
    const list = await request(app).get('/api/admin/messages').set(auth(admin));
    expect(list.status).toBe(200);
    const names = list.body.data.items.map((c) => c.username);
    expect(names).toEqual(expect.arrayContaining([aliceUser.username, bobUser.username]));
    expect(list.body.data.items[0].unread).toBeGreaterThan(0);

    const bobConversation = await conversationOf(bobUser.id);
    const open = await request(app).get(`/api/admin/messages/${bobConversation}`).set(auth(admin));
    expect(open.body.data.messages.map((m) => m.content)).toContain('Message de Bob, privé.');

    await request(app).post(`/api/admin/messages/${bobConversation}`).set(auth(admin)).send({ content: 'Réponse de l’équipe' }).expect(201);
    const unread = await request(app).get('/api/messages/unread').set(auth(bob));
    expect(unread.body.data.unread).toBe(1);
    const read = await request(app).get('/api/messages/team').set(auth(bob));
    expect(read.body.data.messages.at(-1)).toMatchObject({ content: 'Réponse de l’équipe', from_team: true });
    expect((await request(app).get('/api/messages/unread').set(auth(bob))).body.data.unread).toBe(0);
  });
});

describe('limite de débit et rétention', () => {
  test(`au-delà de ${MEMBER_MESSAGES_PER_HOUR} messages par heure : 429`, async () => {
    const carol = await login(app, await createUser({ prefix: 'msgcarol' }));
    for (let i = 0; i < MEMBER_MESSAGES_PER_HOUR; i += 1) {
      expect((await send(carol, { content: `Message ${i}` })).status).toBe(201);
    }
    const res = await send(carol, { content: 'Un de trop' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  test('conversation supprimée 12 mois après le dernier échange', async () => {
    const id = await conversationOf(aliceUser.id);
    await pool.query("UPDATE conversations SET last_message_at = NOW() - INTERVAL '13 months' WHERE id = $1", [id]);
    await purgeExpiredData();
    expect(await conversationOf(aliceUser.id)).toBeUndefined();
    expect((await pool.query('SELECT 1 FROM messages WHERE conversation_id = $1', [id])).rows).toHaveLength(0);
    expect(await conversationOf(bobUser.id)).toBeDefined();
  });
});
