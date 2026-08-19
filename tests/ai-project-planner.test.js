'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmate-ai-planner-'));
process.env.DATABASE_PATH = path.join(tempDir, 'planner.db');
process.env.TOKEN_SECRET = 'planner-test-secret-that-is-long-enough';
process.env.ALLOW_EXTERNAL_AI = 'false';
process.env.GEMINI_API_KEY = '';

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
  const response = await fetch(baseUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

async function register(username, email, fullName) {
  const result = await request('/api/auth/register', { method:'POST', body:{ username, email, full_name:fullName, password:'Password123!' } });
  assert.equal(result.status, 201);
  return result.data;
}

test('AI brief planner previews max-six main workstreams, detailed subtasks and nested heavy work; commit preserves reviewed hierarchy', async () => {
  const owner = await register('planowner', 'planowner@example.com', 'Plan Owner');
  const teammate = await register('plandesigner', 'plandesigner@example.com', 'Plan Designer');
  const organization = await request('/api/organizations', { method:'POST', token:owner.token, body:{ name:'AI Planning Team' } });
  assert.equal(organization.status, 201);
  const orgId = organization.data.id;

  const invite = await request(`/api/organizations/${orgId}/invitations`, { method:'POST', token:owner.token, body:{ identifier:'plandesigner', proposed_role:'member', proposed_department:'Design' } });
  assert.equal(invite.status, 201);
  const accepted = await request(`/api/invitations/${invite.data.id}/accept`, { method:'POST', token:teammate.token, body:{} });
  assert.equal(accepted.status, 200);

  const brief = 'Create and launch a customer project portal with secure login, dashboard, task tracking, responsive UI, testing, and final handoff.';
  const preview = await request(`/api/organizations/${orgId}/ai-project-plan/preview`, { method:'POST', token:owner.token, body:{ brief } });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.fallback_used, true);
  assert.ok(preview.data.plan.project_name);
  assert.ok(preview.data.plan.main_tasks.length >= 4);
  assert.ok(preview.data.plan.main_tasks.length <= 6);
  assert.ok(preview.data.members.length >= 2);

  const allowedIds = new Set(preview.data.members.map(member => Number(member.user_id)));
  let nestedPreviewCount = 0;
  for (const main of preview.data.plan.main_tasks) {
    assert.ok(main.title);
    assert.ok(main.subtasks.length >= 5);
    assert.ok(allowedIds.has(Number(main.manager_id)));
    for (const subtask of main.subtasks) {
      assert.ok(subtask.title);
      assert.ok(allowedIds.has(Number(subtask.assignee_id)));
      assert.ok(['small','medium','heavy'].includes(subtask.complexity));
      for (const child of subtask.child_tasks || []) {
        nestedPreviewCount += 1;
        assert.ok(child.title);
        assert.ok(allowedIds.has(Number(child.assignee_id)));
      }
    }
  }
  assert.ok(nestedPreviewCount >= 10, 'fallback plan should demonstrate meaningful nested subdivision');

  const reviewed = structuredClone(preview.data.plan);
  reviewed.project_name = 'Reviewed Customer Portal';
  reviewed.main_tasks[0].title = 'Reviewed main workstream';
  reviewed.main_tasks[0].subtasks[0].accepted = false;
  const firstNestedParent = reviewed.main_tasks.flatMap(main => main.subtasks).find(sub => (sub.child_tasks || []).length > 0);
  assert.ok(firstNestedParent);
  firstNestedParent.child_tasks[0].accepted = false;
  reviewed.main_tasks[1].accepted = false;

  const acceptedMains = reviewed.main_tasks.filter(item => item.accepted !== false);
  const expectedMain = acceptedMains.length;
  const expectedDirect = acceptedMains.reduce((sum, item) => sum + item.subtasks.filter(sub => sub.accepted !== false).length, 0);
  const expectedNested = acceptedMains.reduce((sum, item) => sum + item.subtasks.filter(sub => sub.accepted !== false).reduce((subSum, sub) => subSum + (sub.child_tasks || []).filter(child => child.accepted !== false).length, 0), 0);

  const commit = await request(`/api/organizations/${orgId}/ai-project-plan/commit`, { method:'POST', token:owner.token, body:{ brief, plan:reviewed } });
  assert.equal(commit.status, 201);
  assert.equal(commit.data.main_task_count, expectedMain);
  assert.equal(commit.data.direct_subtask_count, expectedDirect);
  assert.equal(commit.data.nested_subtask_count, expectedNested);
  assert.equal(commit.data.task_count, expectedMain + expectedDirect + expectedNested);
  assert.equal(commit.data.project_name, 'Reviewed Customer Portal');

  const tasks = await request(`/api/lists/${commit.data.list_id}/tasks`, { token:owner.token });
  assert.equal(tasks.status, 200);
  assert.equal(tasks.data.length, expectedMain + expectedDirect + expectedNested);
  const byId = new Map(tasks.data.map(task => [Number(task.id), task]));
  const mains = tasks.data.filter(task => !task.parent_task_id);
  const direct = tasks.data.filter(task => task.parent_task_id && !byId.get(Number(task.parent_task_id))?.parent_task_id);
  const nested = tasks.data.filter(task => task.parent_task_id && byId.get(Number(task.parent_task_id))?.parent_task_id);
  assert.equal(mains.length, expectedMain);
  assert.equal(direct.length, expectedDirect);
  assert.equal(nested.length, expectedNested);
  assert.ok(mains.some(task => task.title === 'Reviewed main workstream'));
  assert.ok(direct.every(task => mains.some(main => Number(main.id) === Number(task.parent_task_id))));
  assert.ok(nested.every(task => direct.some(sub => Number(sub.id) === Number(task.parent_task_id))));
  assert.ok(tasks.data.every(task => task.ai_generated === 1 && task.approved === 1 && task.source_type === 'ai_project_plan'));
});

