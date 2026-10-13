const crypto = require('crypto');
const { pool } = require('../config/database');
const { logger } = require('../utils/logger');

/*
 * Registre des connexions temps réel (Server-Sent Events).
 *
 * - Une connexion n'est enregistrée qu'après authentification par la session
 *   serveur (cookie HttpOnly) : l'identité vient de la table sessions, jamais
 *   de l'adresse IP ni d'une donnée envoyée par le navigateur.
 * - Plusieurs onglets d'un même utilisateur = plusieurs connexions, mais un
 *   seul destinataire dans les statistiques.
 * - Les sessions sont revalidées périodiquement et juste avant chaque
 *   diffusion : une session révoquée ou expirée ne reçoit plus rien et son
 *   flux est fermé.
 *
 * LIMITE : ce registre vit dans la mémoire du processus Node. Avec plusieurs
 * processus (cluster, plusieurs conteneurs « app »), chaque processus ne voit
 * que ses propres connexions. Il faudrait alors relayer les diffusions entre
 * processus (PostgreSQL LISTEN/NOTIFY ou Redis pub/sub). Le déploiement actuel
 * (npm start ou un unique conteneur app derrière Nginx) n'a qu'un processus.
 */

const MAX_CONNECTIONS_PER_USER = Number(process.env.REALTIME_MAX_PER_USER || 5);
const MAX_CONNECTIONS_TOTAL = Number(process.env.REALTIME_MAX_TOTAL || 2000);
const HEARTBEAT_MS = Number(process.env.REALTIME_HEARTBEAT_MS || 20000);
const REVALIDATE_MS = Number(process.env.REALTIME_REVALIDATE_MS || 30000);

/** userId -> Map(connectionId -> connection) */
const connectionsByUser = new Map();
let totalConnections = 0;
let heartbeatTimer = null;
let revalidateTimer = null;

function writeEvent(connection, event, data, id) {
  if (connection.closed || connection.res.writableEnded || connection.res.destroyed) {
    throw new Error('connection closed');
  }
  let frame = '';
  if (id) frame += `id: ${id}\n`;
  if (event) frame += `event: ${event}\n`;
  // JSON.stringify n'émet jamais de saut de ligne brut : une seule ligne data.
  frame += `data: ${JSON.stringify(data)}\n\n`;
  connection.res.write(frame);
}

function forEachConnection(fn) {
  for (const userConnections of connectionsByUser.values()) {
    for (const connection of [...userConnections.values()]) fn(connection);
  }
}

function unregister(connection) {
  const userConnections = connectionsByUser.get(connection.userId);
  if (!userConnections || !userConnections.delete(connection.id)) return;
  totalConnections -= 1;
  if (userConnections.size === 0) connectionsByUser.delete(connection.userId);
  if (totalConnections === 0) stopTimers();
}

/** Ferme proprement un flux (événement facultatif envoyé avant la fermeture). */
function closeConnection(connection, reason) {
  if (connection.closed) return;
  if (reason) {
    try { writeEvent(connection, 'session-ended', { reason }); } catch (error) { /* déjà fermé */ }
  }
  connection.closed = true;
  unregister(connection);
  try { connection.res.end(); } catch (error) { /* socket déjà détruite */ }
}

function heartbeat() {
  forEachConnection((connection) => {
    try {
      connection.res.write(': ping\n\n');
    } catch (error) {
      closeConnection(connection);
    }
  });
}

/**
 * Relit en une requête toutes les sessions associées à des flux ouverts et
 * ferme les flux dont la session n'est plus valide. Ne prolonge PAS la
 * session (last_seen_at n'est pas modifié).
 */
async function revalidateSessions() {
  const connections = [];
  forEachConnection((connection) => connections.push(connection));
  if (connections.length === 0) return 0;

  const hashes = [...new Set(connections.map((connection) => connection.tokenHash))];
  const result = await pool.query(
    `
      SELECT s.token_hash
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ANY($1::text[])
        AND s.revoked_at IS NULL
        AND s.mfa_pending = false
        AND s.expires_at > NOW()
        AND s.last_seen_at + make_interval(secs => s.idle_timeout_seconds) > NOW()
        AND u.is_active = true
        AND u.is_banned = false
    `,
    [hashes]
  );
  const valid = new Set(result.rows.map((row) => row.token_hash));

  let closed = 0;
  for (const connection of connections) {
    if (!valid.has(connection.tokenHash)) {
      closeConnection(connection, 'session_expired');
      closed += 1;
    }
  }
  return closed;
}

function startTimers() {
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    heartbeatTimer.unref();
  }
  if (!revalidateTimer) {
    revalidateTimer = setInterval(() => {
      revalidateSessions().catch((error) => logger.warn('Realtime session revalidation failed', { error: error.message }));
    }, REVALIDATE_MS);
    revalidateTimer.unref();
  }
}

function stopTimers() {
  clearInterval(heartbeatTimer);
  clearInterval(revalidateTimer);
  heartbeatTimer = null;
  revalidateTimer = null;
}

/**
 * Enregistre un flux authentifié. Retourne la connexion, ou null si la limite
 * globale est atteinte. Au-delà de MAX_CONNECTIONS_PER_USER onglets, le plus
 * ancien flux de l'utilisateur est fermé.
 */
function register({ req, res, userId, sessionId, tokenHash }) {
  if (totalConnections >= MAX_CONNECTIONS_TOTAL) return null;

  let userConnections = connectionsByUser.get(userId);
  if (!userConnections) {
    userConnections = new Map();
    connectionsByUser.set(userId, userConnections);
  }
  while (userConnections.size >= MAX_CONNECTIONS_PER_USER) {
    const oldest = userConnections.values().next().value;
    closeConnection(oldest, 'too_many_connections');
  }
  // closeConnection peut avoir supprimé l'entrée de la Map : on la remet.
  connectionsByUser.set(userId, userConnections);

  const connection = {
    id: crypto.randomUUID(),
    userId,
    sessionId,
    tokenHash,
    res,
    closed: false,
    openedAt: Date.now(),
  };
  userConnections.set(connection.id, connection);
  totalConnections += 1;

  const onClose = () => {
    connection.closed = true;
    unregister(connection);
  };
  req.on('close', onClose);
  res.on('close', onClose);
  res.on('error', onClose);

  startTimers();
  return connection;
}

/**
 * Diffuse un événement à toutes les connexions actives.
 * Retourne des statistiques réelles :
 *  - connectedUserIds  : utilisateurs uniques ayant au moins un flux valide
 *  - deliveredUserIds  : utilisateurs uniques ayant reçu au moins une copie
 *  - deliveredConnections / failedConnections : par flux (onglet)
 * « Distribué » signifie écrit dans le flux, pas affiché ni lu.
 */
async function broadcast(event, data, id) {
  // Une session révoquée depuis la dernière vérification ne doit rien recevoir.
  await revalidateSessions();

  const connectedUserIds = [];
  const deliveredUserIds = [];
  let deliveredConnections = 0;
  let failedConnections = 0;

  for (const [userId, userConnections] of [...connectionsByUser.entries()]) {
    connectedUserIds.push(userId);
    let delivered = false;
    for (const connection of [...userConnections.values()]) {
      try {
        writeEvent(connection, event, data, id);
        deliveredConnections += 1;
        delivered = true;
      } catch (error) {
        failedConnections += 1;
        closeConnection(connection);
      }
    }
    if (delivered) deliveredUserIds.push(userId);
  }

  return { connectedUserIds, deliveredUserIds, deliveredConnections, failedConnections };
}

function closeSession(sessionId, reason = 'logout') {
  forEachConnection((connection) => {
    if (connection.sessionId === sessionId) closeConnection(connection, reason);
  });
}

function closeSessionByHash(tokenHash, reason = 'logout') {
  forEachConnection((connection) => {
    if (connection.tokenHash === tokenHash) closeConnection(connection, reason);
  });
}

function closeUser(userId, reason = 'logout', { exceptSessionId = null } = {}) {
  const userConnections = connectionsByUser.get(userId);
  if (!userConnections) return;
  for (const connection of [...userConnections.values()]) {
    if (connection.sessionId !== exceptSessionId) closeConnection(connection, reason);
  }
}

function presence() {
  return { connected_users: connectionsByUser.size, connections: totalConnections };
}

/** Tests / arrêt du serveur : ferme tous les flux. */
function closeAll(reason = 'server_shutdown') {
  forEachConnection((connection) => closeConnection(connection, reason));
  stopTimers();
}

module.exports = {
  register,
  broadcast,
  closeSession,
  closeSessionByHash,
  closeUser,
  closeAll,
  presence,
  revalidateSessions,
  writeEvent,
  MAX_CONNECTIONS_PER_USER,
};
