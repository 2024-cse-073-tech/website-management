'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-workspace-'));
process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
process.env.TOKEN_SECRET = 'test-secret-that-is-long-enough';

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
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

async function register(username, email, fullName) {
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: { username, email, full_name: fullName, password: 'Password123!' }
  });
  assert.equal(result.status, 201);
  return result.data;
}


test('registration does not require organization creation and workspace stays locked', async () => {
  const standalone = await register('standalone', 'standalone@example.com', 'Standalone User');
  assert.equal(standalone.workspace_access.can_access_workspace, false);
  assert.equal(standalone.workspace_access.requires_onboarding, true);

  const me = await request('/api/auth/me', { token: standalone.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.organizations, []);
  assert.equal(me.data.workspace_access.can_access_workspace, false);
  assert.equal(me.data.workspace_access.active_organization_count, 0);
  assert.equal(me.data.workspace_access.requires_onboarding, true);

  const organizations = await request('/api/organizations', { token: standalone.token });
  assert.equal(organizations.status, 200);
  assert.deepEqual(organizations.data, []);
});

test('invitation acceptance immediately joins workspace and unlocks role-based access', async () => {
  const ceo = await register('founder', 'founder@example.com', 'Founder User');
  const teammate = await register('teammate', 'teammate@example.com', 'Team Mate');

  const teammateBeforeInvite = await request('/api/auth/me', { token: teammate.token });
  assert.equal(teammateBeforeInvite.data.workspace_access.can_access_workspace, false);

  const organizationResult = await request('/api/organizations', {
    method: 'POST', token: ceo.token, body: { name: 'Test Company' }
  });
  assert.equal(organizationResult.status, 201);
  assert.equal(organizationResult.data.role, 'ceo');
  const organizationId = organizationResult.data.id;

  const inviteResult = await request(`/api/organizations/${organizationId}/invitations`, {
    method: 'POST', token: ceo.token, body: { identifier: 'teammate', proposed_role: 'member' }
  });
  assert.equal(inviteResult.status, 201);
  assert.match(inviteResult.data.invite_url, /\?invite=/);
  const invitationId = inviteResult.data.id;

  const invites = await request('/api/invitations/me', { token: teammate.token });
  assert.equal(invites.status, 200);
  assert.equal(invites.data[0].status, 'invited');

  const preJoinAccess = await request(`/api/organizations/${organizationId}`, { token: teammate.token });
  assert.equal(preJoinAccess.status, 403);

  const accept = await request(`/api/invitations/${invitationId}/accept`, { method: 'POST', token: teammate.token });
  assert.equal(accept.status, 200);
  assert.equal(accept.data.status, 'approved');
  assert.equal(accept.data.membership.role, 'member');

  const memberAccess = await request(`/api/organizations/${organizationId}`, { token: teammate.token });
  assert.equal(memberAccess.status, 200);
  assert.equal(memberAccess.data.membership.role, 'member');
  const unlockedAccess = await request('/api/auth/me', { token: teammate.token });
  assert.equal(unlockedAccess.data.workspace_access.can_access_workspace, true);
  assert.equal(unlockedAccess.data.workspace_access.pending_invitation_count, 0);
  assert.equal(unlockedAccess.data.workspace_access.requires_onboarding, false);

  // Manager approval endpoint remains idempotent for older clients.
  const approve = await request(`/api/invitations/${invitationId}/approve`, { method: 'POST', token: ceo.token });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, 'approved');

  const membershipId = accept.data.membership.id;
  const promote = await request(`/api/memberships/${membershipId}`, {
    method: 'PATCH', token: ceo.token, body: { role: 'moderator', status: 'active' }
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.data.role, 'moderator');

  const channel = await request(`/api/organizations/${organizationId}/channels`, {
    method: 'POST', token: teammate.token, body: { name: 'delivery', topic: 'Delivery coordination' }
  });
  assert.equal(channel.status, 201);

  const project = await request(`/api/organizations/${organizationId}/projects`, {
    method: 'POST', token: teammate.token, body: { name: 'Website Launch', objective: 'Launch the website' }
  });
  assert.equal(project.status, 201);

  const plan = await request(`/api/projects/${project.data.id}/generate-plan`, {
    method: 'POST', token: teammate.token, body: { brief: 'Build and launch a secure website.' }
  });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.created_task_ids.length, 8);
});

test('password accepts 8 characters and rejects shorter passwords', async () => {
  const accepted = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'eightpass', email: 'eightpass@example.com', full_name: 'Eight Pass', password: 'Abcd123!' }
  });
  assert.equal(accepted.status, 201);

  const rejected = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'sevenpass', email: 'sevenpass@example.com', full_name: 'Seven Pass', password: 'Abc123!' }
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.detail, /at least 8 characters/i);
});

test('personal mode works without requiring a team organization', async () => {
  const personalUser = await register('personaluser', 'personal@example.com', 'Personal User');
  const personal = await request('/api/personal-workspace', { method: 'POST', token: personalUser.token, body: {} });
  assert.equal(personal.status, 201);
  assert.equal(personal.data.workspace_type, 'personal');

  const me = await request('/api/auth/me', { token: personalUser.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.workspace_access.can_access_workspace, true);
  assert.ok(me.data.organizations.some(org => org.workspace_type === 'personal'));

  const tree = await request(`/api/organizations/${personal.data.id}/workspace-tree`, { token: personalUser.token });
  assert.equal(tree.status, 200);
  assert.ok(Array.isArray(tree.data));
});

test('email invite link can be created before signup and joined after registration', async () => {
  const owner = await register('linkowner', 'linkowner@example.com', 'Link Owner');
  const organization = await request('/api/organizations', { method: 'POST', token: owner.token, body: { name: 'Link Team' } });
  assert.equal(organization.status, 201);

  const invite = await request(`/api/organizations/${organization.data.id}/invitations`, {
    method: 'POST', token: owner.token, body: { identifier: 'futureguest@example.com', proposed_role: 'member', proposed_department: 'Product' }
  });
  assert.equal(invite.status, 201);
  assert.equal(invite.data.invited_user_id, null);
  assert.match(invite.data.invite_url, /\?invite=/);

  const token = new URL(invite.data.invite_url).searchParams.get('invite');
  assert.ok(token);
  const guest = await register('futureguest', 'futureguest@example.com', 'Future Guest');
  const joined = await request('/api/invitations/join', { method: 'POST', token: guest.token, body: { token } });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.status, 'joined');
  assert.equal(joined.data.organization.id, organization.data.id);

  const joinedAgain = await request('/api/invitations/join', { method: 'POST', token: guest.token, body: { token } });
  assert.equal(joinedAgain.status, 200);
  assert.equal(joinedAgain.data.status, 'already_joined');
});

test('iteration 2 member directory, departments, presence, invitations, and organization switching', async () => {
  const owner = await register('iter2owner', 'iter2owner@example.com', 'Iteration Owner');
  const designer = await register('iter2designer', 'iter2designer@example.com', 'Design Member');
  const pendingUser = await register('iter2pending', 'iter2pending@example.com', 'Pending Member');

  const firstOrganization = await request('/api/organizations', {
    method: 'POST', token: owner.token, body: { name: 'Iteration Two One' }
  });
  assert.equal(firstOrganization.status, 201);

  const secondOrganization = await request('/api/organizations', {
    method: 'POST', token: owner.token, body: { name: 'Iteration Two Two' }
  });
  assert.equal(secondOrganization.status, 201);

  const organizations = await request('/api/organizations', { token: owner.token });
  assert.equal(organizations.status, 200);
  assert.equal(organizations.data.filter(item => item.name.startsWith('Iteration Two')).length, 2);

  const organizationId = firstOrganization.data.id;
  const invitation = await request(`/api/organizations/${organizationId}/invitations`, {
    method: 'POST', token: owner.token,
    body: { identifier: 'iter2designer', proposed_role: 'member', proposed_department: 'Design' }
  });
  assert.equal(invitation.status, 201);
  assert.equal(invitation.data.proposed_department, 'Design');

  await request(`/api/invitations/${invitation.data.id}/accept`, { method: 'POST', token: designer.token });
  const approved = await request(`/api/invitations/${invitation.data.id}/approve`, { method: 'POST', token: owner.token });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.membership.department, 'Design');

  const away = await request('/api/presence/me', {
    method: 'PATCH', token: designer.token,
    body: { presence_mode: 'away', custom_status: 'Reviewing design system' }
  });
  assert.equal(away.status, 200);
  assert.equal(away.data.current_status, 'away');

  const directory = await request(`/api/organizations/${organizationId}/members`, { token: owner.token });
  assert.equal(directory.status, 200);
  const listedDesigner = directory.data.find(member => member.username === 'iter2designer');
  assert.equal(listedDesigner.department, 'Design');
  assert.equal(listedDesigner.current_status, 'away');
  assert.equal(listedDesigner.custom_status, 'Reviewing design system');
  assert.ok(Object.hasOwn(listedDesigner, 'avatar_url'));

  const updatedMembership = await request(`/api/memberships/${listedDesigner.membership_id}`, {
    method: 'PATCH', token: owner.token,
    body: { role: 'moderator', department: 'Product Design', status: 'active' }
  });
  assert.equal(updatedMembership.status, 200);
  assert.equal(updatedMembership.data.role, 'moderator');
  assert.equal(updatedMembership.data.department, 'Product Design');

  const profile = await request('/api/users/me/profile', {
    method: 'PATCH', token: designer.token,
    body: { full_name: 'Design Lead', avatar_url: 'https://example.com/avatar.png' }
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.full_name, 'Design Lead');
  assert.equal(profile.data.avatar_url, 'https://example.com/avatar.png');

  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G5sAAAAASUVORK5CYII=';
  const uploadedAvatar = await request('/api/users/me/profile', {
    method: 'PATCH', token: designer.token,
    body: { avatar_url: tinyPng }
  });
  assert.equal(uploadedAvatar.status, 200);
  assert.equal(uploadedAvatar.data.avatar_url, tinyPng);

  const openInvitation = await request(`/api/organizations/${organizationId}/invitations`, {
    method: 'POST', token: owner.token,
    body: { identifier: 'iter2pending', proposed_role: 'member', proposed_department: 'Operations' }
  });
  assert.equal(openInvitation.status, 201);
  const cancelled = await request(`/api/invitations/${openInvitation.data.id}/cancel`, { method: 'POST', token: owner.token });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');

  const heartbeat = await request('/api/presence/heartbeat', { method: 'POST', token: owner.token });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.data.current_status, 'online');
});

test('iteration 3 profile, status, themes, notifications, and account activity', async () => {
  const owner = await register('iter3owner', 'iter3owner@example.com', 'Iteration Three Owner');
  const teammate = await register('iter3member', 'iter3member@example.com', 'Iteration Three Member');

  const ownerMe = await request('/api/auth/me', { token: owner.token });
  assert.equal(ownerMe.status, 200);
  assert.equal(ownerMe.data.settings.theme, 'light');
  assert.equal(ownerMe.data.presence.status_key, 'available');
  assert.equal(ownerMe.data.presence.status_emoji, '🟢');

  const organization = await request('/api/organizations', {
    method: 'POST', token: owner.token, body: { name: 'Iteration Three Workspace' }
  });
  assert.equal(organization.status, 201);
  const organizationId = organization.data.id;

  const settings = await request('/api/users/me/settings', {
    method: 'PATCH', token: owner.token,
    body: {
      theme: 'dark', workspace_notifications: true, mention_notifications: true,
      invitation_notifications: true, activity_notifications: true
    }
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.theme, 'dark');

  const remoteStatus = await request('/api/presence/me', {
    method: 'PATCH', token: owner.token,
    body: { status_key: 'remote', custom_status: 'Working from Lahore' }
  });
  assert.equal(remoteStatus.status, 200);
  assert.equal(remoteStatus.data.status_label, 'Remote');
  assert.equal(remoteStatus.data.status_emoji, '🏠');
  assert.equal(remoteStatus.data.custom_status, 'Working from Lahore');

  const customStatus = await request('/api/presence/me', {
    method: 'PATCH', token: teammate.token,
    body: { status_key: 'custom', status_label: 'Client Site', status_emoji: '📍', custom_status: 'Back tomorrow' }
  });
  assert.equal(customStatus.status, 200);
  assert.equal(customStatus.data.status_key, 'custom');
  assert.equal(customStatus.data.status_label, 'Client Site');

  const invitation = await request(`/api/organizations/${organizationId}/invitations`, {
    method: 'POST', token: owner.token,
    body: { identifier: 'iter3member', proposed_role: 'member', proposed_department: 'Product' }
  });
  assert.equal(invitation.status, 201);

  const invitationNotifications = await request('/api/users/me/notifications', { token: teammate.token });
  assert.equal(invitationNotifications.status, 200);
  assert.equal(invitationNotifications.data.unread_count, 1);
  assert.equal(invitationNotifications.data.items[0].notification_type, 'invitation');

  const readNotification = await request(`/api/notifications/${invitationNotifications.data.items[0].id}/read`, {
    method: 'PATCH', token: teammate.token
  });
  assert.equal(readNotification.status, 200);
  assert.ok(readNotification.data.read_at);

  await request(`/api/invitations/${invitation.data.id}/accept`, { method: 'POST', token: teammate.token });
  await request(`/api/invitations/${invitation.data.id}/approve`, { method: 'POST', token: owner.token });

  const directory = await request(`/api/organizations/${organizationId}/members`, { token: owner.token });
  assert.equal(directory.status, 200);
  const listedOwner = directory.data.find(member => member.username === 'iter3owner');
  const listedTeammate = directory.data.find(member => member.username === 'iter3member');
  assert.equal(listedOwner.status_key, 'remote');
  assert.equal(listedOwner.status_label, 'Remote');
  assert.equal(listedTeammate.status_key, 'custom');
  assert.equal(listedTeammate.status_emoji, '📍');

  const channels = await request(`/api/organizations/${organizationId}/channels`, { token: owner.token });
  const general = channels.data.find(channel => channel.name === 'general');
  const mention = await request(`/api/channels/${general.id}/messages`, {
    method: 'POST', token: owner.token,
    body: { body: 'Hello @iter3member, please review the profile update.' }
  });
  assert.equal(mention.status, 201);

  const memberNotifications = await request('/api/users/me/notifications', { token: teammate.token });
  assert.ok(memberNotifications.data.items.some(item => item.notification_type === 'mention'));
  assert.ok(memberNotifications.data.items.some(item => item.notification_type === 'invitation'));

  const activityResult = await request('/api/users/me/activity', { token: owner.token });
  assert.equal(activityResult.status, 200);
  assert.ok(activityResult.data.some(item => item.activity_type === 'account_created'));
  assert.ok(activityResult.data.some(item => item.activity_type === 'settings_updated'));
  assert.ok(activityResult.data.some(item => item.activity_type === 'status_updated'));
  assert.ok(activityResult.data.some(item => item.activity_type === 'organization_created'));

  const readAll = await request('/api/users/me/notifications/read-all', { method: 'POST', token: teammate.token });
  assert.equal(readAll.status, 200);
  const afterReadAll = await request('/api/users/me/notifications', { token: teammate.token });
  assert.equal(afterReadAll.data.unread_count, 0);
});

test('new workspace does not create the legacy Project Management sample project', async () => {
  const owner = await register('nosampleowner', 'nosampleowner@example.com', 'No Sample Owner');
  const organization = await request('/api/organizations', {
    method: 'POST', token: owner.token, body: { name: 'Clean Workspace' }
  });
  assert.equal(organization.status, 201);

  const tree = await request(`/api/organizations/${organization.data.id}/workspace-tree`, { token: owner.token });
  assert.equal(tree.status, 200);
  const lists = tree.data.flatMap(space => [...(space.lists || []), ...(space.folders || []).flatMap(folder => folder.lists || [])]);
  assert.equal(lists.length, 0, 'fresh workspace contains no auto-created sample project/list');

  const projects = await request(`/api/organizations/${organization.data.id}/projects`, { token: owner.token });
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.data, []);
});
