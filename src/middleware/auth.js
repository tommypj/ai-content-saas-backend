'use strict';

const jwt = require('jsonwebtoken');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

/**
 * requireAuth — verifies "Authorization: Bearer <jwt>"
 * On failure, returns 401 with a specific { reason } for easier debugging.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== 'string') {
    logger.warn('[auth] missing Authorization header');
    res.set('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Unauthorized', reason: 'MISSING_AUTH_HEADER' });
  }
  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme) || !token) {
    logger.warn('[auth] malformed Authorization header');
    res.set('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Unauthorized', reason: 'MALFORMED_AUTH_HEADER' });
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('[auth] JWT_SECRET not set');
    res.set('Content-Type', 'application/json');
    return res.status(500).json({ error: 'Server misconfigured', reason: 'MISSING_JWT_SECRET' });
  }
  try {
    const payload = jwt.verify(token, secret);
    // Normalize fields: support tokens signed with { sub, username } (no email)
    const id = payload.id || payload.sub || null;
    const email = payload.email || null;
    const username = payload.username || null;
    if (!id) {
      logger.warn('[auth] token verified but missing id/sub');
      res.set('Content-Type', 'application/json');
      return res.status(401).json({ error: 'Unauthorized', reason: 'INVALID_TOKEN_PAYLOAD' });
    }
    req.user = { id, email, username };
    return next();
  } catch (err) {
    logger.warn(`[auth] token verify failed: ${err?.name || 'Error'} - ${err?.message || ''}`.trim());
    res.set('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Unauthorized', reason: 'INVALID_TOKEN' });
  }
}

module.exports = { requireAuth };
