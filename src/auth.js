'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const COOKIE_NAME = 'orbit_session';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(input) {
  return crypto.createHmac('sha256', config.tokenSecret).update(input).digest('base64url');
}

function createToken(user, sessionId = crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: Number(user.id),
    username: user.username,
    sid: sessionId,
    iat: now,
    exp: now + config.tokenTtlHours * 3600
  }));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') return null;
    if (!Number.isInteger(Number(parsed.sub)) || !parsed.exp || parsed.exp < now || parsed.iat > now + 60) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const value = String(stored || '');
    let salt;
    let hash;
    let options = { N: 16384, r: 8, p: 1 };
    if (value.startsWith('scrypt$')) {
      const [, n, r, p, parsedSalt, parsedHash] = value.split('$');
      salt = parsedSalt;
      hash = parsedHash;
      options = { N: Number(n), r: Number(r), p: Number(p) };
    } else {
      // Backwards-compatible verification for databases created by earlier iterations.
      [salt, hash] = value.split(':');
    }
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64, options);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function parseCookies(request) {
  const result = {};
  const cookieHeader = String(request.headers.cookie || '');
  for (const item of cookieHeader.split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    const key = item.slice(0, index).trim();
    const rawValue = item.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(rawValue); } catch { result[key] = rawValue; }
  }
  return result;
}

function bearerToken(request) {
  const header = String(request.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return parseCookies(request)[COOKIE_NAME] || '';
}

function usesCookieAuthentication(request) {
  const header = String(request.headers.authorization || '');
  return !header.toLowerCase().startsWith('bearer ') && Boolean(parseCookies(request)[COOKIE_NAME]);
}

function sessionCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.round(config.tokenTtlHours * 3600)}`
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  COOKIE_NAME,
  createToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  bearerToken,
  usesCookieAuthentication,
  sessionCookie,
  clearSessionCookie
};
