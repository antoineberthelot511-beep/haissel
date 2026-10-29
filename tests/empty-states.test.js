/*
 * États vides de la messagerie et de l'Activité : l'ours « aucun message »
 * seulement avec 0 message (envoi optimiste compris), jamais pendant le
 * chargement ; Activité : seules les réponses de l'équipe créent un élément.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const helpers = require('./helpers/setup');

const { app } = require('../src/app');

const { createUser, login, auth } = helpers;
const FRONTEND = path.join(__dirname, '../frontend');
const read = (name) => fs.readFileSync(path.join(FRONTEND, name), 'utf8');
const sandbox = { Date, Number, Promise };
sandbox.window = sandbox;
vm.runInNewContext(read('chat-thread.js'), sandbox);
const Chat = sandbox.HaisselChat;
const appJs = read('app.js');

let pool;
beforeAll(async () => { pool = await helpers.setupDatabase(); }, 30000);
afterAll(async () => { await helpers.teardownDatabase(); });

describe('conversation : ours « aucun message »', () => {
  const member = { id: 1, content: 'Bonjour', from_team: false, created_at: new Date().toISOString() };

  test('0 message → ours ; 1 message du membre → pas d’ours ; pas d’ours pendant le chargement', () => {
    expect(Chat.showEmptyState([], true)).toBe(true);
    expect(Chat.showEmptyState([member], true)).toBe(false);
    expect(Chat.showEmptyState([], false)).toBe(false);
  });

  test('envoi optimiste : l’ours disparaît tout de suite (avant la réponse du serveur)', () => {
    const store = Chat.createThreadStore({ send: () => new Promise(() => {}) });
    store.applyServer([]);
    expect(Chat.showEmptyState(store.messages(), true)).toBe(true);
    store.post('Ma question');
    expect(store.messages()[0].status).toBe('sending');
    expect(Chat.showEmptyState(store.messages(), true)).toBe(false);
  });

  test('app.js : plus de règle « l’équipe n’a encore rien répondu », fondu de 150 ms, pas d’ours 10', () => {
    expect(appJs).not.toMatch(/chat-hint|const waiting = !messages\.some/);
    expect(appJs).not.toMatch(/message-recu/);
    const render = appJs.slice(appJs.indexOf('function renderChat()'), appJs.indexOf('function scrollChatToEnd'));
    expect(render).toContain('window.HaisselChat.showEmptyState(messages, entry.loaded)');
    expect(render).toMatch(/empty\.classList\.add\('is-leaving'\);\s*window\.setTimeout\(\(\) => empty\.remove\(\), reducedMotion\(\) \? 0 : 150\);/);
    expect(read('app-v2.css')).toMatch(/\.chat-empty \{[^}]*transition: opacity 150ms ease;/);
  });

  test('console admin : même règle par conversation, ours 16 seulement sans aucune conversation', () => {
    const admin = read('admin.js');
    expect(admin).toMatch(/\.\.\.\(data\.messages\.length \? \[\] : \[\s*h\('div', \{ className: 'empty mascot-state' \}, bear\('aucun-message', 120\)/);
    expect(admin).toMatch(/: \[h\('li', \{ className: 'empty mascot-state' \}, bear\('admin-support', 120\)/);
  });
});

describe('Activité', () => {
  test('un message du membre ne crée rien ; une réponse de l’équipe crée un élément', async () => {
    const user = await createUser({ prefix: 'emptyact' });
    const identity = await login(app, user);
    const before = await request(app).get('/api/messages/activity').set(auth(identity));
    expect(before.status).toBe(200);
    expect(before.body.data.items.filter((i) => i.type === 'team_message')).toHaveLength(0);

    const sent = await request(app).post('/api/messages/team').set(auth(identity)).send({ content: 'Une question' });
    expect(sent.status).toBe(201);
    const mine = await request(app).get('/api/messages/activity').set(auth(identity));
    expect(mine.body.data.items).toHaveLength(before.body.data.items.length);

    const conv = (await pool.query('SELECT id FROM conversations WHERE member_id = $1', [user.id])).rows[0].id;
    const admin = await createUser({ admin: true, prefix: 'emptyactadmin' });
    await pool.query("INSERT INTO messages (conversation_id, sender_id, content, from_team) VALUES ($1, $2, 'Réponse', true)", [conv, admin.id]);
    const after = await request(app).get('/api/messages/activity').set(auth(identity));
    expect(after.body.data.items.filter((i) => i.type === 'team_message')).toHaveLength(1);
  });

  test('ours « vide-dodo » seulement si la liste chargée est vide', () => {
    const render = appJs.slice(appJs.indexOf('function renderActivity()'), appJs.indexOf('function renderActivity()') + 900);
    expect(render).toMatch(/if \(!activity\.loaded\) \{[\s\S]*?'Chargement…'[\s\S]*?return;\s*\}\s*if \(!activity\.items\.length\) \{[\s\S]*?bear\('vide-dodo', 140\)/);
  });
});
