'use strict';
/**
 * JWT verification middleware for protected routes.
 * Usage: app.get('/api/v1/secure', requireAuth, handler)
 */

const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      const err = new Error('JWT_SECRET not configured');
      err.status = 500;
      throw err;
    }

    const payload = jwt.verify(token, secret); // throws on invalid/expired
    // attach to req for downstream handlers
    req.auth = { userId: payload.sub, username: payload.username };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next(err);
  }
}

module.exports = { requireAuth };
