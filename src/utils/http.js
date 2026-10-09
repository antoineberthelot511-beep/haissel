function sendError(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: { code, message },
  });
}

function parsePagination(query, maxLimit = 100) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

/** Entier strictement positif (identifiant SQL) ou null. */
function parseId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 && id <= 2147483647 ? id : null;
}

module.exports = {
  sendError,
  parsePagination,
  parseId,
};
