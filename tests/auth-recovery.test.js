'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-auth-recovery-'));
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'auth-recovery-test-secret-with-more-than-32-characters';
process.env.AUTH_RATE_LIMIT_PER_15_MINUTES = '100';
process.env.API_RATE_LIMIT_PER_MINUTE = '1000';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;

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

async function request(pathname, { method = 'GET', token = '', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

test('forgot password issues a one-time development code and changes the password', async () => {
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: {
      username: 'recover.user',
      email: 'recover.user@example.com',
      full_name: 'Recover User',
      password: 'Password123!'
    }
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.persistent_account, false);
  assert.ok(registered.data.token);

  const forgot = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: 'recover.user@example.com' }
  });
  assert.equal(forgot.status, 200);
  assert.match(forgot.data.dev_reset_code, /^\d{6}$/);

  const reset = await request('/api/auth/reset-password', {
    method: 'POST',
    body: {
      email: 'recover.user@example.com',
      code: forgot.data.dev_reset_code,
      password: 'NewPassword456!'
    }
  });
  assert.equal(reset.status, 200);

  const oldSession = await request('/api/auth/me', { token: registered.data.token });
  assert.equal(oldSession.status, 401);

  const oldPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'recover.user', password: 'Password123!' }
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { identifier: 'recover.user@example.com', password: 'NewPassword456!' }
  });
  assert.equal(newPassword.status, 200);
  assert.ok(newPassword.data.token);

  const reusedCode = await request('/api/auth/reset-password', {
    method: 'POST',
    body: {
      email: 'recover.user@example.com',
      code: forgot.data.dev_reset_code,
      password: 'ThirdPassword789!'
    }
  });
  assert.equal(reusedCode.status, 400);
});

test('forgot password response does not reveal whether an email exists', async () => {
  const forgot = await request('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: 'missing-user@example.com' }
  });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.data.dev_reset_code, undefined);
  assert.match(forgot.data.message, /If an account exists/i);
});
