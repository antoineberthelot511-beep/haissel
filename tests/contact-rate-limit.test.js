/*
 * Formulaire de contact : 3 envois acceptés par heure et par adresse IP.
 * Fichier à part : les limiteurs y sont actifs (RATE_LIMIT_IN_TESTS).
 */
process.env.RATE_LIMIT_IN_TESTS = 'true';
const helpers = require('./helpers/setup');

const request = require('supertest');
const { app } = require('../src/app');
const push = require('../src/services/push.service');

beforeAll(async () => {
  await helpers.setupDatabase();
  jest.spyOn(push, 'sendToUser').mockResolvedValue({ sent: 0 });
}, 30000);

afterAll(async () => {
  delete process.env.RATE_LIMIT_IN_TESTS;
  await helpers.teardownDatabase();
});

const body = { subject: 'other', message: 'Une demande assez longue pour être valide.', reply_email: 'ip@exemple.fr' };

test('une erreur de saisie ne compte pas ; le 4e envoi de l’heure est refusé', async () => {
  expect((await request(app).post('/api/contact').send({ ...body, message: 'court' })).status).toBe(400);
  for (let i = 0; i < 3; i += 1) {
    expect((await request(app).post('/api/contact').send(body)).status).toBe(201);
  }
  const res = await request(app).post('/api/contact').send(body);
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
});
