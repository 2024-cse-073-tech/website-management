'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dbSource = fs.readFileSync(path.join(root, 'src', 'db.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('v2.8 uses the shared Turso adapter for the full server data path', () => {
  assert.match(dbSource, /import\('@libsql\/client'\)/);
  assert.match(dbSource, /const useTurso = Boolean\(config\.turso\.url && config\.turso\.authToken\)/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS organizations/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS projects/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS tasks/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS messages/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS suggestions/);
  assert.doesNotMatch(serverSource, /require\(['"]\.\/authStore['"]\)/);
  assert.match(serverSource, /database_storage: db\.storageMode\(\)/);
  assert.match(serverSource, /persistent: db\.storageMode\(\) === 'turso'/);
  assert.equal(pkg.dependencies['@libsql/client'], '^0.17.4');
  assert.match(envExample, /Persistent FULL workspace database/);
});
