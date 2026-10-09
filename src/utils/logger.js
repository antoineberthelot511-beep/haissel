/*
 * Journalisation minimale horodatée.
 * Ne jamais passer de mot de passe, de JWT, de secret ou de DATABASE_URL.
 */
const silent = process.env.NODE_ENV === 'test' && process.env.LOG_IN_TESTS !== 'true';

function format(level, message, meta) {
  const base = `${new Date().toISOString()} [${level}] ${message}`;
  return meta && Object.keys(meta).length ? `${base} ${JSON.stringify(meta)}` : base;
}

const logger = {
  info(message, meta) {
    if (!silent) console.log(format('INFO', message, meta));
  },
  warn(message, meta) {
    if (!silent) console.warn(format('WARN', message, meta));
  },
  error(message, meta) {
    if (!silent) console.error(format('ERROR', message, meta));
  },
};

module.exports = { logger };
