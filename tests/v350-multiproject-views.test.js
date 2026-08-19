'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmate-v350-'));
process.env.DATABASE_PATH = path.join(tempDir, 'v350.db');
process.env.TOKEN_SECRET = 'v350-test-secret-that-is-long-enough';
process.env.ALLOW_EXTERNAL_AI = 'false';
process.env.GROQ_API_KEY = '';

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
  await db.close();
  fs.rmSync(tempDir, { recursive:true, force:true });
});

async function request(pathname, { method='GET', token='', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status:response.status, data:text ? JSON.parse(text) : {} };
}

async function register() {
  const result = await request('/api/auth/register', { method:'POST', body:{ username:'multiproject', email:'multiproject@example.com', full_name:'Multi Project Owner', password:'Password123!' } });
  assert.equal(result.status, 201);
  return result.data;
}

async function createAiProject(orgId, token, brief, name) {
  const preview = await request(`/api/organizations/${orgId}/ai-project-plan/preview`, { method:'POST', token, body:{ brief } });
  assert.equal(preview.status, 200);
  const plan = structuredClone(preview.data.plan);
  plan.project_name = name;
  const commit = await request(`/api/organizations/${orgId}/ai-project-plan/commit`, { method:'POST', token, body:{ brief, plan } });
  assert.equal(commit.status, 201);
  return commit.data;
}

test('separate client briefs remain separate selectable projects and custom views persist per project', async () => {
  const owner = await register();
  const org = await request('/api/organizations', { method:'POST', token:owner.token, body:{ name:'Client Delivery Workspace' } });
  assert.equal(org.status, 201);
  const orgId = org.data.id;

  const first = await createAiProject(orgId, owner.token, 'Build a premium footwear e-commerce storefront with catalog, checkout, admin, QA and launch.', 'Footwear Client');
  const second = await createAiProject(orgId, owner.token, 'Build a legal case management portal with matters, documents, deadlines, billing, security and deployment.', 'Legal Client');

  assert.notEqual(first.project_id, second.project_id);
  assert.notEqual(first.list_id, second.list_id);

  const projects = await request(`/api/organizations/${orgId}/projects`, { token:owner.token });
  assert.equal(projects.status, 200);
  const firstProject = projects.data.find(item => Number(item.id) === Number(first.project_id));
  const secondProject = projects.data.find(item => Number(item.id) === Number(second.project_id));
  assert.ok(firstProject, 'first project remains listed');
  assert.ok(secondProject, 'second project remains listed');
  assert.equal(Number(firstProject.list_id), Number(first.list_id));
  assert.equal(Number(secondProject.list_id), Number(second.list_id));

  const firstTasks = await request(`/api/lists/${first.list_id}/tasks`, { token:owner.token });
  const secondTasks = await request(`/api/lists/${second.list_id}/tasks`, { token:owner.token });
  assert.equal(firstTasks.status, 200);
  assert.equal(secondTasks.status, 200);
  assert.ok(firstTasks.data.length > 0 && secondTasks.data.length > 0);
  assert.ok(firstTasks.data.every(task => Number(task.project_id) === Number(first.project_id)));
  assert.ok(secondTasks.data.every(task => Number(task.project_id) === Number(second.project_id)));

  const allTasks = await request(`/api/organizations/${orgId}/tasks?scope=all`, { token:owner.token });
  assert.equal(allTasks.status, 200);
  assert.equal(allTasks.data.length, firstTasks.data.length + secondTasks.data.length, 'All Tasks returns every task from every project');
  assert.ok(allTasks.data.some(task => Number(task.project_id) === Number(first.project_id)));
  assert.ok(allTasks.data.some(task => Number(task.project_id) === Number(second.project_id)));
  assert.ok(allTasks.data.every(task => Number.isInteger(Number(task.task_depth))), 'All Tasks includes hierarchy depth metadata');
  assert.ok(allTasks.data.some(task => Number(task.task_depth) === 0), 'main tasks are present');
  assert.ok(allTasks.data.some(task => Number(task.task_depth) === 1), 'subtasks are present');
  assert.ok(allTasks.data.some(task => Number(task.task_depth) >= 2), 'nested subtasks are present');
  assert.ok(allTasks.data.every(task => task.project_name), 'All Tasks includes project location');

  const tree = await request(`/api/organizations/${orgId}/workspace-tree`, { token:owner.token });
  const allLists = tree.data.flatMap(space => [...(space.lists || []), ...(space.folders || []).flatMap(folder => folder.lists || [])]);
  assert.ok(allLists.some(list => Number(list.id) === Number(first.list_id)), 'first project list remains in workspace tree');
  assert.ok(allLists.some(list => Number(list.id) === Number(second.list_id)), 'second project list remains in workspace tree');

  const view = await request(`/api/lists/${first.list_id}/views`, { method:'POST', token:owner.token, body:{ name:'Client Board', view_type:'board' } });
  assert.equal(view.status, 201);
  assert.equal(view.data.view_type, 'board');
  const views = await request(`/api/lists/${first.list_id}/views`, { token:owner.token });
  assert.equal(views.status, 200);
  assert.ok(views.data.some(item => item.name === 'Client Board'));

  const secondViews = await request(`/api/lists/${second.list_id}/views`, { token:owner.token });
  assert.equal(secondViews.status, 200);
  assert.equal(secondViews.data.length, 0, 'custom views stay scoped to their project/list');
});
