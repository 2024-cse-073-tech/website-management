'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmate-v340-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'v340-test-secret-that-is-long-enough-for-tests';
process.env.ALLOW_EXTERNAL_AI = 'false';
process.env.TURSO_DATABASE_URL = '';
process.env.TURSO_AUTH_TOKEN = '';

const db = require('../src/db');
const { createServer } = require('../src/server');
const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

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
  fs.rmSync(tempDir, { recursive:true, force:true });
});

async function request(pathname, { method='GET', token='', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, { method, headers, body:body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  return { status:response.status, data };
}

async function register(username, fullName=username) {
  const result = await request('/api/auth/register', { method:'POST', body:{ username, email:`${username}@example.com`, full_name:fullName, password:'Password123!' } });
  assert.equal(result.status, 201);
  return result.data;
}

async function inviteAndJoin(orgId, ownerToken, member, department) {
  const invite = await request(`/api/organizations/${orgId}/invitations`, { method:'POST', token:ownerToken, body:{ identifier:member.user.username, proposed_role:'member', proposed_department:department } });
  assert.equal(invite.status, 201);
  const joined = await request(`/api/invitations/${invite.data.id}/accept`, { method:'POST', token:member.token, body:{} });
  assert.equal(joined.status, 200);
}

test('Slack-style work status UI is wired and persisted by the presence API', async () => {
  assert.match(htmlSource, /id="statusDialog"/);
  assert.match(appSource, /WORK_STATUS/);
  assert.match(appSource, /Set work status/);
  assert.match(appSource, /saveWorkStatus/);

  const user = await register('statususer', 'Status User');
  const status = await request('/api/presence/me', { method:'PATCH', token:user.token, body:{ status_key:'work_from_home', custom_status:'Available on chat' } });
  assert.equal(status.status, 200);
  assert.equal(status.data.status_key, 'work_from_home');
  assert.equal(status.data.status_label, 'Work From Home');
  assert.equal(status.data.custom_status, 'Available on chat');
});

test('AI preview preassigns all task levels, avoids leave/DND and keeps CEO as project manager', async () => {
  const ceo = await register('ceoowner', 'CEO Owner');
  const designer = await register('designer1', 'Designer One');
  const backend = await register('backend1', 'Backend One');
  const qa = await register('qauser1', 'QA User');
  const leave = await register('leaveuser', 'Leave User');

  const org = await request('/api/organizations', { method:'POST', token:ceo.token, body:{ name:'Assignment Team' } });
  assert.equal(org.status, 201);
  const orgId = org.data.id;
  await inviteAndJoin(orgId, ceo.token, designer, 'Design');
  await inviteAndJoin(orgId, ceo.token, backend, 'Engineering');
  await inviteAndJoin(orgId, ceo.token, qa, 'QA');
  await inviteAndJoin(orgId, ceo.token, leave, 'Operations');

  await request('/api/presence/me', { method:'PATCH', token:designer.token, body:{ status_key:'work_from_home' } });
  await request('/api/presence/me', { method:'PATCH', token:backend.token, body:{ status_key:'on_work' } });
  await request('/api/presence/me', { method:'PATCH', token:qa.token, body:{ status_key:'busy' } });
  await request('/api/presence/me', { method:'PATCH', token:leave.token, body:{ status_key:'on_leave' } });

  const preview = await request(`/api/organizations/${orgId}/ai-project-plan/preview`, { method:'POST', token:ceo.token, body:{ brief:'Build and launch a modern ecommerce platform with authentication, product catalog, search, cart, checkout, admin dashboard, analytics, testing, documentation and deployment.' } });
  assert.equal(preview.status, 200);
  assert.equal(Number(preview.data.project_manager.user_id), Number(ceo.user.id));
  assert.equal(preview.data.project_manager.role, 'ceo');
  assert.equal(preview.data.plan.main_tasks.length, 6);

  const leaveId = Number(leave.user.id);
  const assignees = [];
  const mainManagers = [];
  for (const main of preview.data.plan.main_tasks) {
    assert.ok(main.manager_id, 'main task must have a manager');
    mainManagers.push(Number(main.manager_id));
    for (const sub of main.subtasks) {
      assert.ok(sub.assignee_id, 'direct subtask must be pre-assigned');
      assignees.push(Number(sub.assignee_id));
      for (const child of sub.child_tasks || []) {
        assert.ok(child.assignee_id, 'nested subtask must be pre-assigned');
        assignees.push(Number(child.assignee_id));
      }
    }
  }
  assert.equal(assignees.includes(leaveId), false, 'On Leave user should not receive automatic execution work');
  assert.equal(mainManagers.includes(leaveId), false, 'On Leave user should not be an automatic workstream manager');
  assert.ok(new Set(mainManagers).size >= 2, 'main task managers should be diversified when multiple people exist');
  assert.ok(mainManagers.some(id => id !== Number(ceo.user.id)), 'CEO should not own every main workstream');

  const commit = await request(`/api/organizations/${orgId}/ai-project-plan/commit`, { method:'POST', token:ceo.token, body:{ brief:'Build and launch a modern ecommerce platform with authentication, product catalog, search, cart, checkout, admin dashboard, analytics, testing, documentation and deployment.', plan:preview.data.plan } });
  assert.equal(commit.status, 201);
  assert.equal(Number(commit.data.project_manager_id), Number(ceo.user.id));
  const project = await request(`/api/projects/${commit.data.project_id}`, { token:ceo.token });
  assert.equal(project.status, 200);
  assert.equal(Number(project.data.project_manager_id), Number(ceo.user.id));
  assert.equal(project.data.project_manager_name, 'CEO Owner');
});
