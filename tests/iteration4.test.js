'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const http = require('node:http');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-iteration4-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'iteration-four-test-secret-with-more-than-32-characters';
process.env.AUTH_RATE_LIMIT_PER_15_MINUTES = '100';
process.env.API_RATE_LIMIT_PER_MINUTE = '1000';

const db = require('../src/db');
const { createServer } = require('../src/server');

db.initDb();
const server = createServer();
let baseUrl;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, { method = 'GET', token = '', cookie = '', origin = '', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { response, status: response.status, data };
}

test('production security headers and health endpoints are deployment safe', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.service, 'flowmate-workspace');
  assert.equal(Object.hasOwn(health.data, 'database'), false);
  assert.match(health.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(health.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(health.response.headers.get('x-request-id'));
  assert.ok(health.response.headers.get('ratelimit-limit'));

  const live = await request('/api/health/live');
  const ready = await request('/api/health/ready');
  assert.equal(live.status, 200);
  assert.equal(ready.status, 200);
  assert.equal(ready.data.status, 'ready');

  const wrongMethod = await request('/api/health', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.data.code, 'METHOD_NOT_ALLOWED');
});

test('HttpOnly cookie sessions are usable and logout revokes the server-side session', async () => {
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: {
      username: 'secure.user',
      email: 'secure.user@example.com',
      full_name: 'Secure User',
      password: 'Password123!'
    }
  });
  assert.equal(registration.status, 201);
  assert.ok(registration.data.token);
  const setCookie = registration.response.headers.get('set-cookie');
  assert.match(setCookie, /orbit_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];

  const meWithCookie = await request('/api/auth/me', { cookie });
  assert.equal(meWithCookie.status, 200);
  assert.equal(meWithCookie.data.user.username, 'secure.user');

  const sessions = await request('/api/users/me/sessions', { cookie });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.data.length, 1);
  assert.equal(sessions.data[0].current, true);

  const crossSiteMutation = await request('/api/presence/heartbeat', {
    method: 'POST', cookie, origin: 'https://evil.example'
  });
  assert.equal(crossSiteMutation.status, 403);

  const logout = await request('/api/auth/logout', { method: 'POST', token: registration.data.token });
  assert.equal(logout.status, 200);
  assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);

  const revoked = await request('/api/auth/me', { token: registration.data.token });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.code, 'UNAUTHENTICATED');
});

test('request validation rejects unsupported media types and oversized declared bodies', async () => {
  const unsupported = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'username=test'
  });
  assert.equal(unsupported.status, 415);

  const oversizedStatus = await new Promise((resolve, reject) => {
    const target = new URL(baseUrl + '/api/auth/login');
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2000000' }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(oversizedStatus, 413);
});
