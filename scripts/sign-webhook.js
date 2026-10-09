/*
 * Outil de test : envoie un webhook de conversion signé au serveur local.
 * Simule ce que ferait un partenaire d'affiliation.
 *
 *   node scripts/sign-webhook.js --provider partner --code HAI-XXXXXXXX \
 *     --reference ORDER-1 --amount 1250 --status approved [--click-id 42] \
 *     [--url http://localhost:3000]
 *
 * Utilise AFFILIATE_WEBHOOK_SECRET_<PROVIDER> ou AFFILIATE_WEBHOOK_SECRET (.env).
 */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = String(args.provider || '').toLowerCase();
  const secret = process.env[`AFFILIATE_WEBHOOK_SECRET_${provider.toUpperCase().replace(/-/g, '_')}`]
    || process.env.AFFILIATE_WEBHOOK_SECRET;

  if (!provider || !args.code || !args.reference || args.amount === undefined) {
    console.error('Usage : node scripts/sign-webhook.js --provider partner --code HAI-XXXXXXXX --reference ORDER-1 --amount 1250 [--status approved] [--click-id 42]');
    process.exitCode = 1;
    return;
  }
  if (!secret) {
    console.error('Aucun secret webhook configuré dans .env (AFFILIATE_WEBHOOK_SECRET).');
    process.exitCode = 1;
    return;
  }

  const body = JSON.stringify({
    external_reference: args.reference,
    code: args.code,
    amount_cents: Number(args.amount),
    currency: args.currency || 'EUR',
    status: args.status || 'pending',
    ...(args['click-id'] ? { click_id: Number(args['click-id']) } : {}),
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const baseUrl = args.url || `http://localhost:${process.env.PORT || 3000}`;

  const response = await fetch(`${baseUrl}/api/webhooks/affiliate/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Haissel-Timestamp': timestamp,
      'X-Haissel-Signature': `sha256=${signature}`,
    },
    body,
  });

  console.log(response.status, await response.text());
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
