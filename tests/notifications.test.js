/*
 * Centre de notifications administrateur : diffusion temps réel (SSE).
 * PostgreSQL réel (schéma isolé) + vrai serveur HTTP local pour les flux.
 */
const helpers = require('./helpers/setup');

const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const request = require('supertest');
const { app } = require('../src/app');
const realtime = require('../src/services/realtime.service');
const { sha256 } = require('../src/services/session.service');
const { validateBroadcast } = require('../src/controllers/broadcast.controller');

const { createUser, login, auth } = helpers;

let pool;
let server;
let port;
const openStreams = [];

beforeAll(async () => {
  pool = await helpers.setupDatabase();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => { server.once('listening', resolve); });
  port = server.address().port;
}, 30000);

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.close();
  realtime.closeAll('test');
});

afterAll(async () => {
  realtime.closeAll('test');
  await new Promise((resolve) => { server.close(resolve); });
  await helpers.teardownDatabase();
});

// ---------------------------------------------------------------------------
// Client SSE minimal
// ---------------------------------------------------------------------------

function parseBlock(block) {
  const event = {};
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event.event = line.slice(7);
    else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
    else if (line.startsWith('id: ')) event.id = line.slice(4);
  }
  return event;
}

function openStream(identity) {
  return new Promise((resolve, reject) => {
    const headers = identity ? { Cookie: identity.cookie } : {};
    const req = http.get({ host: '127.0.0.1', port, path: '/api/notifications/stream', headers }, (res) => {
      const stream = {
        status: res.statusCode,
        events: [],
        ended: false,
        body: '',
        close: () => req.destroy(),
      };
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (res.statusCode !== 200) {
          stream.body += chunk;
          return;
        }
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const parsed = parseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (parsed.event) stream.events.push(parsed);
          index = buffer.indexOf('\n\n');
        }
      });
      res.on('end', () => { stream.ended = true; });
      res.on('close', () => { stream.ended = true; });
      res.on('error', () => { stream.ended = true; });
      openStreams.push(stream);
      resolve(stream);
    });
    req.on('error', reject);
  });
}

async function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout');
    await new Promise((resolve) => { setTimeout(resolve, 15); });
  }
}

async function openReadyStream(identity) {
  const stream = await openStream(identity);
  expect(stream.status).toBe(200);
  await waitFor(() => stream.events.some((event) => event.event === 'ready'));
  return stream;
}

const notificationsOf = (stream) => stream.events.filter((event) => event.event === 'admin-notification');

async function adminIdentity() {
  const admin = await createUser({ admin: true, prefix: 'notifadmin' });
  return login(app, admin);
}

async function userIdentity(prefix = 'notifuser') {
  const user = await createUser({ prefix });
  const identity = await login(app, user);
  return { user, identity };
}

function send(identity, body) {
  return request(app).post('/api/admin/notifications').set(auth(identity)).send(body);
}

const SAMPLE = { title: 'Je personnalise', message: 'Je personnalise', target: 'connected_users' };

// ---------------------------------------------------------------------------
// Autorisations
// ---------------------------------------------------------------------------

describe('autorisations de diffusion', () => {
  test('un administrateur peut diffuser', async () => {
    const admin = await adminIdentity();
    const res = await send(admin, SAMPLE);
    expect(res.status).toBe(201);
    expect(res.body.data.broadcast.status).toBe('no_recipients');
  });

  test('un utilisateur normal est refusé (403), même en se déclarant admin', async () => {
    const { identity } = await userIdentity();
    const res = await request(app).post('/api/admin/notifications')
      .set(auth(identity)).set('X-Role', 'ADMIN').send({ ...SAMPLE, title: 'refus-user', role: 'ADMIN' });
    expect(res.status).toBe(403);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM notification_broadcasts WHERE title = $1', ['refus-user']);
    expect(count.rows[0].n).toBe(0);
  });

  test('un visiteur non authentifié est refusé (401)', async () => {
    const res = await request(app).post('/api/admin/notifications').send(SAMPLE);
    expect(res.status).toBe(401);
    const list = await request(app).get('/api/admin/notifications');
    expect(list.status).toBe(401);
  });

  test('une requête sans jeton CSRF est refusée', async () => {
    const admin = await adminIdentity();
    const res = await request(app).post('/api/admin/notifications').set('Cookie', admin.cookie).send(SAMPLE);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  test('une requête cross-site est refusée même avec le jeton', async () => {
    const admin = await adminIdentity();
    const res = await request(app).post('/api/admin/notifications').set(auth(admin))
      .set('Sec-Fetch-Site', 'cross-site').send(SAMPLE);
    expect(res.status).toBe(403);
  });

  test('le flux exige une session (401 sans cookie)', async () => {
    const stream = await openStream(null);
    expect(stream.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation des champs', () => {
  let admin;
  beforeAll(async () => { admin = await adminIdentity(); });

  test.each([
    [{ ...SAMPLE, title: '' }, 'titre vide'],
    [{ ...SAMPLE, title: '   ' }, 'titre blanc'],
    [{ ...SAMPLE, message: '' }, 'message vide'],
    [{ ...SAMPLE, title: 'x'.repeat(81) }, 'titre trop long'],
    [{ ...SAMPLE, message: 'x'.repeat(501) }, 'message trop long'],
    [{ ...SAMPLE, title: 42 }, 'titre non textuel'],
    [{ ...SAMPLE, target: '192.168.1.20' }, 'cible IP arbitraire'],
    [{ ...SAMPLE, target: 'all' }, 'cible inconnue'],
    [{ ...SAMPLE, url: 'https://exemple.com' }, 'URL externe'],
    [{ ...SAMPLE, url: '//exemple.com' }, 'URL protocole relatif'],
    [{ ...SAMPLE, url: 'javascript:alert(1)' }, 'URL javascript:'],
    [{ ...SAMPLE, url: '/admin' }, 'URL admin'],
    [{ ...SAMPLE, url: `/app#${'a'.repeat(250)}` }, 'URL trop longue'],
  ])('refuse : %#', async (body) => {
    const res = await send(admin, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('normalise les entrées (espaces, caractères de contrôle)', () => {
    const { value } = validateBroadcast({
      title: '  Bonjour\u0000  à\ttous \u202E ',
      message: 'Ligne 1\r\n\r\n\r\n\r\nLigne 2  ',
      url: '/mes-affilies',
    });
    expect(value).toEqual({ title: 'Bonjour à tous', message: 'Ligne 1\n\nLigne 2', url: '/mes-affilies', target: 'connected_users' });
  });

  test('80 caractères accentués exactement sont acceptés', async () => {
    const res = await send(admin, { ...SAMPLE, title: 'é'.repeat(80) });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Diffusion
// ---------------------------------------------------------------------------

describe('diffusion temps réel', () => {
  test('plusieurs utilisateurs et plusieurs onglets : un utilisateur compté une fois', async () => {
    const admin = await adminIdentity();
    const a = await userIdentity('alice');
    const b = await userIdentity('bob');
    const tabA1 = await openReadyStream(a.identity);
    const tabA2 = await openReadyStream(a.identity);
    const tabB = await openReadyStream(b.identity);

    const res = await send(admin, { ...SAMPLE, url: '/app' });
    expect(res.status).toBe(201);
    expect(res.body.data.broadcast).toMatchObject({
      status: 'delivered', connected_users: 2, delivered_users: 2, delivered_connections: 3, failed_connections: 0,
    });

    for (const stream of [tabA1, tabA2, tabB]) {
      await waitFor(() => notificationsOf(stream).length === 1);
      const [event] = notificationsOf(stream);
      expect(event.id).toBe(res.body.data.broadcast.id);
      expect(event.data).toEqual({
        id: res.body.data.broadcast.id, title: SAMPLE.title, message: SAMPLE.message, url: '/app', sent_at: expect.any(String),
      });
    }

    const rows = await pool.query(
      `SELECT r.user_id FROM notification_recipients r JOIN notification_broadcasts b ON b.id = r.broadcast_id
       WHERE b.public_id = $1 ORDER BY r.user_id`,
      [res.body.data.broadcast.id]
    );
    expect(rows.rows.map((row) => row.user_id)).toEqual([a.user.id, b.user.id].sort((x, y) => x - y));
  });

  test('le contenu HTML / JavaScript est transmis tel quel, comme du texte', async () => {
    const admin = await adminIdentity();
    const { identity } = await userIdentity();
    const stream = await openReadyStream(identity);
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    const res = await send(admin, { ...SAMPLE, title: '<b>Titre</b>', message: payload });
    expect(res.status).toBe(201);
    await waitFor(() => notificationsOf(stream).length === 1);
    expect(notificationsOf(stream)[0].data.message).toBe(payload);
    expect(notificationsOf(stream)[0].data.title).toBe('<b>Titre</b>');
  });

  test('un utilisateur déconnecté du flux ne reçoit rien et n’est pas compté', async () => {
    const admin = await adminIdentity();
    const { identity } = await userIdentity();
    const stream = await openReadyStream(identity);
    const before = realtime.presence().connected_users;
    stream.close();
    await waitFor(() => realtime.presence().connected_users === before - 1);

    const res = await send(admin, SAMPLE);
    expect(res.body.data.broadcast.connected_users).toBe(0);
    expect(res.body.data.broadcast.status).toBe('no_recipients');
    expect(notificationsOf(stream)).toHaveLength(0);
  });

  test('reconnexion après une perte réseau : les diffusions suivantes arrivent', async () => {
    const admin = await adminIdentity();
    const { identity } = await userIdentity();
    const first = await openReadyStream(identity);
    first.close(); // coupure brutale de la connexion
    await waitFor(() => realtime.presence().connections === 0);

    const second = await openReadyStream(identity);
    const res = await send(admin, SAMPLE);
    expect(res.body.data.broadcast.delivered_users).toBe(1);
    await waitFor(() => notificationsOf(second).length === 1);
  });

  test('nombre d’onglets limité par utilisateur : le plus ancien est fermé', async () => {
    const { identity } = await userIdentity();
    const streams = [];
    for (let i = 0; i < realtime.MAX_CONNECTIONS_PER_USER; i += 1) streams.push(await openReadyStream(identity));
    const extra = await openReadyStream(identity);

    await waitFor(() => streams[0].ended);
    expect(streams[0].events.at(-1)).toMatchObject({ event: 'session-ended', data: { reason: 'too_many_connections' } });
    expect(extra.ended).toBe(false);
    expect(realtime.presence()).toMatchObject({ connected_users: 1, connections: realtime.MAX_CONNECTIONS_PER_USER });
  });

  test('déconnexion : le flux est fermé immédiatement', async () => {
    const { identity } = await userIdentity();
    const stream = await openReadyStream(identity);
    const res = await request(app).post('/api/auth/logout').set(auth(identity));
    expect(res.status).toBe(200);
    await waitFor(() => stream.ended);
    expect(stream.events.at(-1)).toMatchObject({ event: 'session-ended', data: { reason: 'logout' } });
  });

  test('session révoquée pendant le flux (hors application) : plus aucune donnée reçue', async () => {
    const admin = await adminIdentity();
    const { identity } = await userIdentity();
    const stream = await openReadyStream(identity);
    const token = identity.cookie.split('=')[1];
    await pool.query("UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'test' WHERE token_hash = $1", [sha256(token)]);

    const res = await send(admin, SAMPLE);
    expect(res.body.data.broadcast.delivered_users).toBe(0);
    await waitFor(() => stream.ended);
    expect(notificationsOf(stream)).toHaveLength(0);
    expect(stream.events.at(-1)).toMatchObject({ event: 'session-ended', data: { reason: 'session_expired' } });

    const again = await openStream(identity);
    expect(again.status).toBe(401);
  });

  test('erreur de distribution sur un onglet : comptée, les autres reçoivent', async () => {
    const admin = await adminIdentity();
    const { user, identity } = await userIdentity();
    const healthy = await openReadyStream(identity);

    // Connexion dont l'écriture échoue (socket cassée).
    const fakeReq = new EventEmitter();
    const fakeRes = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      write: () => { throw new Error('EPIPE'); },
      end: () => {},
    });
    const token = identity.cookie.split('=')[1];
    realtime.register({ req: fakeReq, res: fakeRes, userId: user.id, sessionId: 0, tokenHash: sha256(token) });

    const res = await send(admin, SAMPLE);
    expect(res.status).toBe(201);
    expect(res.body.data.broadcast).toMatchObject({
      status: 'partial', connected_users: 1, delivered_users: 1, delivered_connections: 1, failed_connections: 1,
    });
    await waitFor(() => notificationsOf(healthy).length === 1);
    expect(realtime.presence().connections).toBe(1);
  });

  test('échec total de diffusion : statut failed enregistré, aucune réussite simulée', async () => {
    const admin = await adminIdentity();
    const spy = jest.spyOn(realtime, 'broadcast').mockRejectedValueOnce(new Error('boom'));
    const res = await send(admin, { ...SAMPLE, title: 'echec-total' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('BROADCAST_FAILED');
    const row = await pool.query("SELECT status FROM notification_broadcasts WHERE title = 'echec-total'");
    expect(row.rows[0].status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Accusés d'affichage et historique
// ---------------------------------------------------------------------------

describe('accusés d’affichage et historique', () => {
  test('seul un destinataire réel peut confirmer, une seule fois', async () => {
    const admin = await adminIdentity();
    const reader = await userIdentity('reader');
    const outsider = await userIdentity('outsider');
    await openReadyStream(reader.identity);

    const res = await send(admin, { ...SAMPLE, title: 'avec-accuse' });
    const { id } = res.body.data.broadcast;

    const noCsrf = await request(app).post(`/api/notifications/${id}/ack`).set('Cookie', reader.identity.cookie).send({ mode: 'system' });
    expect(noCsrf.status).toBe(403);

    const badMode = await request(app).post(`/api/notifications/${id}/ack`).set(auth(reader.identity)).send({ mode: 'read' });
    expect(badMode.status).toBe(400);

    const other = await request(app).post(`/api/notifications/${id}/ack`).set(auth(outsider.identity)).send({ mode: 'in_app' });
    expect(other.body.data.recorded).toBe(false);

    const ok = await request(app).post(`/api/notifications/${id}/ack`).set(auth(reader.identity)).send({ mode: 'system' });
    expect(ok.body.data.recorded).toBe(true);
    const twice = await request(app).post(`/api/notifications/${id}/ack`).set(auth(reader.identity)).send({ mode: 'system' });
    expect(twice.body.data.recorded).toBe(false);

    const history = await request(app).get('/api/admin/notifications').set(auth(admin));
    expect(history.status).toBe(200);
    const item = history.body.data.items.find((row) => row.id === id);
    expect(item).toMatchObject({ title: 'avec-accuse', connected_users: 1, delivered_users: 1, displayed_users: 1 });
  });

  test('la présence est réservée aux administrateurs', async () => {
    const { identity } = await userIdentity();
    const denied = await request(app).get('/api/admin/notifications/presence').set(auth(identity));
    expect(denied.status).toBe(403);
    const admin = await adminIdentity();
    const ok = await request(app).get('/api/admin/notifications/presence').set(auth(admin));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ connected_users: expect.any(Number), limits: { title: 80, message: 500, url: 200 } });
  });

  test('aucune adresse IP n’est stockée pour les diffusions', async () => {
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('notification_broadcasts', 'notification_recipients')`
    );
    expect(columns.rows.map((row) => row.column_name).filter((name) => /ip/.test(name))).toEqual([]);
  });
});

// ===========================================================================
// Interrogation régulière (mode Vercel)
// ===========================================================================

/*
 * Ces tests appellent /api/notifications/poll directement : la route est
 * montée dans les deux modes, seul le client décide de l'utiliser. Les
 * destinataires sont insérés en base comme le fait sendBroadcast sur Vercel,
 * sans dépendre de VERCEL=1 (qui changerait le comportement de toute
 * l'application au milieu de la suite).
 */
describe('Notifications : endpoint d’interrogation', () => {
  /** Crée une diffusion en base et en désigne les destinataires. */
  async function seedBroadcast(title, userIds) {
    const inserted = await pool.query(
      `INSERT INTO notification_broadcasts (public_id, title, message, status, completed_at)
       VALUES ($1, $2, $3, 'delivered', NOW())
       RETURNING id, public_id`,
      [crypto.randomUUID(), title, `message ${title}`]
    );
    const { id, public_id: publicId } = inserted.rows[0];
    if (userIds.length) {
      await pool.query(
        `INSERT INTO notification_recipients (broadcast_id, user_id)
         SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
        [id, userIds]
      );
    }
    return { id, publicId };
  }

  function poll(identity, since) {
    const query = since === undefined ? '' : `?since=${since}`;
    return request(app).get(`/api/notifications/poll${query}`).set('Cookie', identity.cookie);
  }

  test('refuse l’accès sans session (401)', async () => {
    const res = await request(app).get('/api/notifications/poll');
    expect(res.status).toBe(401);
  });

  test('refuse un cookie de session invalide (401)', async () => {
    const res = await request(app).get('/api/notifications/poll')
      .set('Cookie', 'haissel_sid=jeton-inexistant');
    expect(res.status).toBe(401);
  });

  test('sans « since » : aucun élément, seulement le curseur courant', async () => {
    const { user, identity } = await userIdentity('pollbase');
    const { id } = await seedBroadcast('avant-ouverture', [user.id]);

    const res = await poll(identity);
    expect(res.status).toBe(200);
    // L'historique n'est jamais renvoyé d'un coup à l'ouverture d'un onglet.
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.cursor).toBe(id);
  });

  test('ne renvoie que les diffusions plus récentes que le curseur', async () => {
    const { user, identity } = await userIdentity('pollcursor');

    const first = await poll(identity);
    const start = first.body.data.cursor;

    const older = await seedBroadcast('premiere', [user.id]);
    const newer = await seedBroadcast('seconde', [user.id]);

    const all = await poll(identity, start);
    expect(all.status).toBe(200);
    expect(all.body.data.items.map((item) => item.title)).toEqual(['premiere', 'seconde']);
    expect(all.body.data.cursor).toBe(newer.id);

    // Depuis le curseur de la première : seule la seconde reste à venir.
    const rest = await poll(identity, older.id);
    expect(rest.body.data.items.map((item) => item.title)).toEqual(['seconde']);

    // Curseur à jour : plus rien, et le curseur ne régresse pas.
    const empty = await poll(identity, newer.id);
    expect(empty.body.data.items).toEqual([]);
    expect(empty.body.data.cursor).toBe(newer.id);
  });

  test('ne renvoie pas les diffusions destinées à quelqu’un d’autre', async () => {
    const reader = await userIdentity('pollmine');
    const outsider = await userIdentity('pollother');

    const start = (await poll(outsider.identity)).body.data.cursor;
    await seedBroadcast('pour-le-lecteur', [reader.user.id]);

    const res = await poll(outsider.identity, start);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  test('renvoie le contenu complet et un identifiant utilisable pour l’accusé', async () => {
    const { user, identity } = await userIdentity('pollcontent');
    const start = (await poll(identity)).body.data.cursor;
    const { publicId } = await seedBroadcast('contenu', [user.id]);

    const res = await poll(identity, start);
    const [item] = res.body.data.items;
    expect(item).toMatchObject({ id: publicId, title: 'contenu', message: 'message contenu' });
    expect(typeof item.sent_at).toBe('string');

    // L'identifiant renvoyé est bien celui attendu par la route d'accusé.
    const ack = await request(app).post(`/api/notifications/${item.id}/ack`)
      .set(auth(identity)).send({ mode: 'in_app' });
    expect(ack.status).toBe(200);
    expect(ack.body.data.recorded).toBe(true);
  });

  test('un « since » non numérique est traité comme une absence de curseur', async () => {
    const { user, identity } = await userIdentity('pollbadcursor');
    await seedBroadcast('ignoree', [user.id]);

    const res = await request(app).get('/api/notifications/poll?since=../../etc/passwd')
      .set('Cookie', identity.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(typeof res.body.data.cursor).toBe('number');
  });
});
