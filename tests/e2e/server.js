/*
 * Serveur des tests de bout en bout (Playwright) : base PostgreSQL LOCALE du
 * .env (ou TEST_DATABASE_URL), dans un schéma jetable créé puis supprimé
 * (tests/helpers/setup.js) ; jamais d'identifiants de production.
 *
 * Données : un ADMIN, un membre majeur, quatre offres publiées. Le pseudo du
 * membre est écrit dans un fichier temporaire lu par les tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('../helpers/setup');

const PORT = Number(process.env.E2E_PORT || 4317);
const STATE_FILE = path.join(os.tmpdir(), `haissel-e2e-${PORT}.json`);

async function main() {
  const pool = await helpers.setupDatabase();
  const { app } = require('../../src/app');
  const admin = await helpers.createUser({ admin: true, prefix: 'e2eadmin' });
  const member = await helpers.createUser({ prefix: 'e2emember', adult: true });
  // Tuto d'installation iOS déjà vu : sinon il s'ouvre par-dessus Découvrir (Safari iPhone non installé).
  await pool.query('UPDATE users SET install_tuto_seen_at = NOW() WHERE id = $1', [member.id]);
  const titles = ['Pass Culture', 'Carte Avantage Jeune', 'GitHub Student Pack', 'Anki'];
  for (const [i, title] of titles.entries()) {
    await pool.query(
      `INSERT INTO member_offers (user_id, title, url, description, category, countries, expected_action,
                                  rights_confirmed_at, status, published_at, kind, min_age, conditions, member_benefit)
       VALUES ($1, $2, 'https://example.org/offre', $3, 'education', 'FR', 'Créer ton compte',
               NOW(), 'published', NOW() - ($4 || ' minutes')::interval, $5, 13, 'Résider en France', $6)`,
      [admin.id, title,
        'Gratuit · pas un lien affilié. Une description assez longue pour tenir sur deux lignes dans Découvrir, et même un peu plus.',
        String(i), i % 2 ? 'affiliate' : 'free', i % 2 ? 'Un mois offert' : null]
    );
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ username: member.username, password: helpers.PASSWORD }));

  const server = app.listen(PORT, '127.0.0.1');
  const stop = async () => {
    server.close();
    try { fs.unlinkSync(STATE_FILE); } catch (error) { /* déjà supprimé */ }
    await helpers.teardownDatabase();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { PORT, STATE_FILE };
