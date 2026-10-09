/*
 * Promotion d'un utilisateur existant au rôle ADMIN.
 *
 *   node scripts/promote-admin.js --username alice
 *   node scripts/promote-admin.js --email alice@exemple.fr
 *   node scripts/promote-admin.js --user-id 42
 *   node scripts/promote-admin.js --username alice --demote   (retire le rôle)
 *
 * Idempotent : relancer la commande ne crée aucun doublon.
 */
const { pool } = require('../src/config/database');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function buildLookup(args) {
  if (typeof args['user-id'] === 'string') {
    if (!/^\d{1,10}$/.test(args['user-id'])) return null;
    return { sql: 'SELECT id, username, email, is_active, is_banned FROM users WHERE id = $1', value: Number(args['user-id']) };
  }
  if (typeof args.username === 'string' && args.username.trim()) {
    return { sql: 'SELECT id, username, email, is_active, is_banned FROM users WHERE username = $1', value: args.username.trim().toLowerCase() };
  }
  if (typeof args.email === 'string' && args.email.trim()) {
    return { sql: 'SELECT id, username, email, is_active, is_banned FROM users WHERE email = $1', value: args.email.trim().toLowerCase() };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lookup = buildLookup(args);

  if (!lookup) {
    console.error('Usage : node scripts/promote-admin.js --username alice | --email alice@exemple.fr | --user-id 42 [--demote]');
    process.exitCode = 1;
    return;
  }

  const userResult = await pool.query(lookup.sql, [lookup.value]);
  const user = userResult.rows[0];
  if (!user) {
    console.error(`Utilisateur introuvable (${lookup.value}). Créez d'abord le compte depuis l'interface.`);
    process.exitCode = 1;
    return;
  }

  const label = `${user.username} <${user.email}> (id ${user.id})`;

  if (args.demote) {
    const removed = await pool.query('DELETE FROM admins WHERE user_id = $1 RETURNING id', [user.id]);
    console.log(removed.rowCount ? `Rôle ADMIN retiré : ${label}` : `${label} n'était pas administrateur.`);
    return;
  }

  const result = await pool.query(
    `
      INSERT INTO admins (user_id, role, created_at)
      VALUES ($1, 'ADMIN', NOW())
      ON CONFLICT (user_id) DO UPDATE SET role = 'ADMIN'
      WHERE admins.role IS DISTINCT FROM 'ADMIN'
      RETURNING (xmax = 0) AS inserted
    `,
    [user.id]
  );

  if (result.rowCount === 0) {
    console.log(`Déjà administrateur : ${label}`);
  } else {
    console.log(result.rows[0].inserted ? `Promu ADMIN : ${label}` : `Rôle mis à jour vers ADMIN : ${label}`);
  }

  if (!user.is_active || user.is_banned) {
    console.warn('Attention : ce compte est suspendu ou banni ; il ne pourra pas se connecter tant qu’il n’est pas réactivé.');
  }
}

main()
  .catch((error) => {
    console.error('Échec de la promotion :', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
