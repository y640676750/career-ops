import { getSession } from '../data/sessionStore.js';

function extractBearerToken(headerValue = '') {
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function readSessionToken(req) {
  return extractBearerToken(req.get('authorization')) || req.get('x-session-token') || '';
}

export function attachOptionalSession(req, res, next) {
  const token = readSessionToken(req);
  if (!token) {
    req.session = null;
    return next();
  }

  const session = getSession(token);
  req.session = session;
  return next();
}

export function requireSession(req, res, next) {
  const token = readSessionToken(req);
  if (!token) {
    return res.status(401).json({
      status: 'error',
      message: 'Session token is required.'
    });
  }

  const session = getSession(token);
  if (!session) {
    return res.status(401).json({
      status: 'error',
      message: 'Session is invalid or expired.'
    });
  }

  req.session = session;
  return next();
}
