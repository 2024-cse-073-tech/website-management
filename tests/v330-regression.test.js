'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmate-v330-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'v330-test-secret-that-is-long-enough';
process.env.ALLOW_EXTERNAL_AI = 'false';
process.env.TURSO_DATABASE_URL = '';
process.env.TURSO_AUTH_TOKEN = '';

const db = require('../src/db');
const ai = require('../src/aiEngine');
const { createServer } = require('../src/server');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const themeSource = fs.readFileSync(path.join(root, 'public', 'theme-init.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

const server = createServer();
let baseUrl;

test.before(async () => {
  await db.initDb();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, { method='GET', token='', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

async function register(username) {
  const response = await request('/api/auth/register', { method:'POST', body:{ username, email:`${username}@example.com`, full_name:username, password:'Password123!' } });
  assert.equal(response.status, 201);
  return response.data;
}

test('v3.3 ships an initialized local SQLite database and explicit init command', () => {
  const databasePath = path.join(root, 'data', 'project_assistant_js.db');
  assert.equal(fs.existsSync(databasePath), true);
  assert.ok(fs.statSync(databasePath).size > 0);
  assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /"db:init": "node scripts\/init-db\.js"/);
});

test('theme boot and runtime use the same storage key so refresh does not flash back to light', () => {
  assert.match(themeSource, /localStorage\.getItem\('flowmate-theme'\)/);
  assert.match(appSource, /localStorage\.setItem\('flowmate-theme'/);
  assert.match(themeSource, /dataset\.themePreference/);
  assert.match(appSource, /dataset\.themePreference/);
});

test('AI local fallback produces six main tasks, deep work breakdown and uses all available people', async () => {
  const members = Array.from({ length: 9 }, (_, index) => ({
    user_id:index + 1, full_name:`Person ${index + 1}`, role:index < 2 ? 'admin' : 'member',
    department:['Product','Design','Frontend','Backend','QA','Content','Ops','Data','Support'][index],
    current_status:'online', status_key:'available', capacity:5, active_task_count:index % 3
  }));
  const result = await ai.generateProjectBlueprint('Build and launch a complete multi-user SaaS app with auth, dashboard, chat, AI planning, billing-ready architecture, QA and deployment.', members, {});
  assert.equal(result.plan.main_tasks.length, 6);
  assert.ok(result.plan.main_tasks.every(main => main.subtasks.length >= 6));
  const assigned = new Set();
  for (const main of result.plan.main_tasks) {
    if (main.manager_id) assigned.add(Number(main.manager_id));
    for (const sub of main.subtasks) {
      if (sub.assignee_id) assigned.add(Number(sub.assignee_id));
      for (const child of sub.child_tasks || []) if (child.assignee_id) assigned.add(Number(child.assignee_id));
    }
  }
  assert.deepEqual([...assigned].sort((a,b)=>a-b), members.map(item=>item.user_id));
});

test('manual task builder and real-time channel stream are wired end to end', async () => {
  assert.match(htmlSource, /id="manualBreakdownDialog"/);
  assert.match(appSource, /Create & divide/);
  assert.match(appSource, /data-action="manual-divide"/);
  assert.match(serverSource, /text\/event-stream/);
  assert.match(appSource, /new EventSource\(`\/api\/channels\/\$\{channelId\}\/events`\)/);

  const owner = await register('liveowner');
  const teammate = await register('livemate');
  const org = await request('/api/organizations', { method:'POST', token:owner.token, body:{ name:'Live Team' } });
  const invite = await request(`/api/organizations/${org.data.id}/invitations`, { method:'POST', token:owner.token, body:{ identifier:'livemate', proposed_role:'member' } });
  await request(`/api/invitations/${invite.data.id}/accept`, { method:'POST', token:teammate.token });
  const channel = await request(`/api/organizations/${org.data.id}/channels`, { method:'POST', token:owner.token, body:{ name:'live-chat' } });

  const controller = new AbortController();
  const streamResponse = await fetch(`${baseUrl}/api/channels/${channel.data.id}/events`, { headers:{ Authorization:`Bearer ${teammate.token}` }, signal:controller.signal });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 3000;
  const waitForMessage = (async () => {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      if (buffer.includes('hello live teammate')) return buffer;
    }
    return buffer;
  })();
  const sent = await request(`/api/channels/${channel.data.id}/messages`, { method:'POST', token:owner.token, body:{ body:'hello live teammate' } });
  assert.equal(sent.status, 201);
  const streamed = await Promise.race([waitForMessage, new Promise(resolve => setTimeout(()=>resolve(buffer), 3200))]);
  controller.abort();
  assert.match(streamed, /event: message/);
  assert.match(streamed, /hello live teammate/);
});
