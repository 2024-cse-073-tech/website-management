'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const ai = require('./aiEngine');
const packageJson = require('../package.json');

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

const routes = [];
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const rateLimitBuckets = new Map();
const SERVER_STARTED_AT = Date.now();
const DUMMY_PASSWORD_HASH = auth.hashPassword('NotARealPassword123');
const channelEventStreams = new Map();

function channelStreamSet(channelId) {
  const key = Number(channelId);
  if (!channelEventStreams.has(key)) channelEventStreams.set(key, new Set());
  return channelEventStreams.get(key);
}

function removeChannelStream(channelId, response) {
  const key = Number(channelId);
  const streams = channelEventStreams.get(key);
  if (!streams) return;
  streams.delete(response);
  if (!streams.size) channelEventStreams.delete(key);
}

function writeSse(response, eventName, payload) {
  if (!response || response.writableEnded || response.destroyed) return false;
  try {
    response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch { return false; }
}

function broadcastChannelEvent(channelId, eventName, payload) {
  const streams = channelEventStreams.get(Number(channelId));
  if (!streams) return;
  for (const response of [...streams]) {
    if (!writeSse(response, eventName, payload)) removeChannelStream(channelId, response);
  }
}

function closeRealtimeClients() {
  for (const streams of channelEventStreams.values()) {
    for (const response of streams) {
      try { if (!response.writableEnded) response.end(); } catch {}
    }
  }
  channelEventStreams.clear();
}

function requestId(request) {
  const supplied = String(request.headers['x-request-id'] || '').trim();
  return /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function clientIp(request) {
  if (config.trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 80);
  }
  return String(request.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 80);
}

function clientDescription(request) {
  const agent = cleanString(request.headers['user-agent'], 240) || 'Unknown client';
  return `${agent} · IP ${clientIp(request) || 'unknown'}`;
}

function setCommonHeaders(request, response) {
  const id = requestId(request);
  request.requestId = id;
  response.setHeader('X-Request-ID', id);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https:; connect-src 'self'");
  if (config.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function validateRequestOrigin(request) {
  if (!UNSAFE_METHODS.has(request.method) || !auth.usesCookieAuthentication(request)) return;
  if (String(request.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Invalid request origin'); }
  if (parsed.host !== request.headers.host) throw new HttpError(403, 'Cross-site request blocked');
}

function enforceRateLimit(request, response, routeMatch) {
  if (!request.url.startsWith('/api/')) return;
  const authRoute = routeMatch?.pattern?.startsWith('/api/auth/');
  const windowMs = authRoute ? 15 * 60_000 : 60_000;
  const limit = authRoute ? config.authRateLimitPer15Minutes : config.apiRateLimitPerMinute;
  const key = `${clientIp(request)}:${authRoute ? 'auth' : 'api'}`;
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  const remaining = Math.max(0, limit - bucket.count);
  response.setHeader('RateLimit-Limit', String(limit));
  response.setHeader('RateLimit-Remaining', String(remaining));
  response.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > limit) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    throw new HttpError(429, 'Too many requests. Please try again later.');
  }
  if (rateLimitBuckets.size > 5000) {
    for (const [bucketKey, value] of rateLimitBuckets) if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
  }
}

function compilePath(pattern) {
  const names = [];
  const source = pattern.split('/').map(segment => {
    if (segment.startsWith(':')) {
      names.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { regex: new RegExp(`^${source}$`), names };
}

function route(method, pattern, handler, options = {}) {
  const compiled = compilePath(pattern);
  routes.push({ method, pattern, handler, auth: options.auth !== false, ...compiled });
}

function jsonResponse(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function textResponse(response, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

async function parseBody(request) {
  if (['GET', 'HEAD'].includes(request.method)) return {};
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > config.requestBodyLimitBytes) throw new HttpError(413, 'Request body is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.requestBodyLimitBytes) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('object required');
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body must be a valid JSON object');
  }
}

function publicUser(user) {
  return user ? {
    id: Number(user.id),
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url || '',
    status: user.status,
    created_at: user.created_at
  } : null;
}

function cleanString(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function requiredString(value, field, minLength = 1, maxLength = 5000) {
  const output = cleanString(value, maxLength);
  if (output.length < minLength) throw new HttpError(400, `${field} is required`);
  return output;
}

function integer(value, field = 'id') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, `${field} must be a positive integer`);
  return parsed;
}

function booleanInt(value) {
  return value ? 1 : 0;
}

function normalizeUsername(value) {
  const username = cleanString(value, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-40 characters using letters, numbers, dot, dash, or underscore');
  }
  return username;
}

function normalizeEmail(value) {
  const email = cleanString(value, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'A valid email address is required');
  return email;
}

function normalizeDepartment(value, fallback = 'General') {
  const department = cleanString(value || fallback, 80).replace(/\s+/g, ' ');
  return department || fallback;
}

const WORKSPACE_STATUS_PRESETS = Object.freeze({
  free: { label: 'Free', emoji: '🟢' },
  available: { label: 'Available', emoji: '🟢' }, // legacy-compatible alias
  busy: { label: 'Busy', emoji: '🔴' },
  on_work: { label: 'On Work', emoji: '🔵' },
  work_from_home: { label: 'Work From Home', emoji: '🏠' },
  remote: { label: 'Remote', emoji: '🏠' }, // legacy-compatible alias
  on_leave: { label: 'On Leave', emoji: '🏖️' },
  dnd: { label: 'Do Not Disturb', emoji: '⛔' },
  in_meeting: { label: 'In a Meeting', emoji: '🟡' },
  focus: { label: 'Focus Time', emoji: '🎯' },
  travelling: { label: 'Travelling', emoji: '✈️' },
  custom: { label: 'Custom', emoji: '💬' }
});

function workspaceStatus(value, customLabel = '', customEmoji = '') {
  const key = cleanString(value || 'free', 30).toLowerCase();
  if (!Object.hasOwn(WORKSPACE_STATUS_PRESETS, key)) throw new HttpError(400, 'Invalid workspace status');
  if (key !== 'custom') return { key, ...WORKSPACE_STATUS_PRESETS[key] };
  const label = requiredString(customLabel, 'Custom status label', 2, 50);
  const emoji = cleanString(customEmoji || '💬', 8) || '💬';
  return { key, label, emoji };
}

async function clearExpiredWorkspaceStatuses(userId = null) {
  const now = db.utcnow();
  const where = userId ? 'AND user_id=?' : '';
  const values = userId ? [now, userId] : [now];
  await db.run(
    `UPDATE user_presence
     SET status_key='free',status_label='Free',status_emoji='🟢',custom_status='',status_expires_at=NULL,updated_at=?
     WHERE status_expires_at IS NOT NULL AND status_expires_at<=? ${where}`,
    userId ? [now, now, userId] : [now, now]
  );
}

async function settingsForUser(userId) {
  const existing = await db.get('SELECT * FROM user_settings WHERE user_id=?', [userId]);
  if (existing) return existing;
  const now = db.utcnow();
  await db.run('INSERT INTO user_settings(user_id,theme,workspace_notifications,mention_notifications,invitation_notifications,activity_notifications,updated_at) VALUES(?,?,?,?,?,?,?)', [userId, 'light', 1, 1, 1, 1, now]);
  return await db.get('SELECT * FROM user_settings WHERE user_id=?', [userId]);
}

async function activity(userId, activityType, title, detail = '', organizationId = null) {
  await db.run('INSERT INTO account_activity(user_id,organization_id,activity_type,title,detail,created_at) VALUES(?,?,?,?,?,?)', [userId, organizationId, activityType, title, cleanString(detail, 500), db.utcnow()]);
}

async function notifyUser(userId, notificationType, title, body = '', organizationId = null, actionView = '') {
  const settings = await settingsForUser(userId);
  const preference = notificationType === 'invitation' ? 'invitation_notifications'
    : notificationType === 'mention' ? 'mention_notifications'
      : notificationType === 'activity' ? 'activity_notifications' : 'workspace_notifications';
  if (!Number(settings[preference])) return null;
  return (await db.run('INSERT INTO notifications(user_id,organization_id,notification_type,title,body,action_view,created_at) VALUES(?,?,?,?,?,?,?)', [userId, organizationId, notificationType, cleanString(title, 160), cleanString(body, 500), cleanString(actionView, 40), db.utcnow()])).lastInsertRowid;
}

async function notifyOrganizationManagers(organizationId, title, body, excludeUserId = null) {
  const managers = await db.all("SELECT user_id FROM memberships WHERE organization_id=? AND status='active' AND role IN ('ceo','admin')", [organizationId]);
  for (const manager of managers) if (Number(manager.user_id) !== Number(excludeUserId)) await notifyUser(manager.user_id, 'activity', title, body, organizationId, 'admin');
}

function validateAvatarUrl(value) {
  const avatarValue = String(value || '').trim();
  if (!avatarValue) return '';

  // Settings can store a small, browser-compressed profile picture directly in
  // the existing avatar_url TEXT column. This keeps local SQLite and Turso in
  // sync without requiring a separate object-storage service for profile photos.
  if (avatarValue.startsWith('data:image/')) {
    if (avatarValue.length > 420_000) throw new HttpError(400, 'Profile picture is too large. Choose a smaller image.');
    const match = avatarValue.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw new HttpError(400, 'Profile picture must be a PNG, JPEG, or WebP image');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 300_000) throw new HttpError(400, 'Profile picture must be 300 KB or smaller after compression');
    return avatarValue;
  }

  if (avatarValue.length > 2_000) throw new HttpError(400, 'Avatar URL is too long');
  let parsed;
  try { parsed = new URL(avatarValue); } catch { throw new HttpError(400, 'Avatar URL must be a valid HTTPS address'); }
  if (parsed.protocol !== 'https:') throw new HttpError(400, 'Avatar URL must use HTTPS');
  return avatarValue;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new HttpError(400, 'Password must contain at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  return password;
}

async function uniqueSlug(name) {
  const base = cleanString(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  let slug = base;
  let suffix = 2;
  while (await db.get('SELECT id FROM organizations WHERE slug=?', [slug])) slug = `${base}-${suffix++}`;
  return slug;
}

function requestBaseUrl(request) {
  if (config.appBaseUrl) return config.appBaseUrl;
  const forwardedProto = config.trustProxy ? cleanString(request.headers['x-forwarded-proto'], 20).split(',')[0].trim() : '';
  const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
  const host = cleanString(request.headers.host, 200) || `${config.host}:${config.port}`;
  return `${protocol}://${host}`;
}

function inviteTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function createOrganizationForUser(user, name, workspaceType = 'team') {
  const type = workspaceType === 'personal' ? 'personal' : 'team';
  const now = db.utcnow();
  const created = await db.transaction(async () => {
    const organization = await db.run(
      'INSERT INTO organizations(name,slug,workspace_type,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      [name, await uniqueSlug(name), type, user.id, now, now]
    );
    await db.run(
      'INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      [organization.lastInsertRowid, user.id, 'ceo', type === 'personal' ? 'Personal' : 'Leadership', 'active', now, now]
    );
    await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organization.lastInsertRowid, 'general', type === 'personal' ? 'Your personal notes and updates' : 'Company-wide announcements and discussion', user.id, now]);
    if (type === 'team') {
      await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organization.lastInsertRowid, 'project-updates', 'Project progress, blockers, and decisions', user.id, now]);
    }
    return organization.lastInsertRowid;
  });
  await audit(created, null, user.id, 'organization', created, 'created', { name, workspace_type: type });
  await activity(user.id, type === 'personal' ? 'personal_workspace_created' : 'organization_created', type === 'personal' ? 'Personal workspace created' : 'Organization created', name, created);
  await notifyUser(user.id, 'workspace', type === 'personal' ? 'Your personal workspace is ready' : `Welcome to ${name}`, type === 'personal' ? 'You can work independently now and create or join a team workspace anytime.' : 'Your new organization is ready.', created, 'dashboard');
  return await db.get('SELECT o.*, m.role, m.status membership_status FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE o.id=? AND m.user_id=?', [created, user.id]);
}

async function requireUser(request) {
  const payload = auth.verifyToken(auth.bearerToken(request));
  if (!payload) throw new HttpError(401, 'Authentication required');
  if (payload.sid) {
    const session = await db.get('SELECT * FROM auth_sessions WHERE id=? AND user_id=?', [payload.sid, payload.sub]);
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) throw new HttpError(401, 'Session expired or revoked');
    if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60_000) {
      await db.run('UPDATE auth_sessions SET last_seen_at=? WHERE id=?', [db.utcnow(), payload.sid]);
    }
  }
  const user = await db.get('SELECT * FROM users WHERE id=?', [payload.sub]);
  if (!user || user.status !== 'active') throw new HttpError(401, 'User account is unavailable');
  request.authPayload = payload;
  return user;
}

async function createAuthSession(user, request) {
  const sessionId = crypto.randomUUID();
  const token = auth.createToken(user, sessionId);
  const now = db.utcnow();
  const expiresAt = new Date(Date.now() + config.tokenTtlHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.run(
    'INSERT INTO auth_sessions(id,user_id,ip_address,user_agent,created_at,last_seen_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)',
    [sessionId, user.id, clientIp(request), cleanString(request.headers['user-agent'], 240), now, now, expiresAt]
  );
  return { token, sessionId, expiresAt };
}

function authenticationHeaders(token) {
  return { 'Set-Cookie': auth.sessionCookie(token) };
}

function passwordResetCodeHash(email, code) {
  return crypto.createHmac('sha256', config.tokenSecret).update(`${String(email || '').trim().toLowerCase()}:${String(code || '').trim()}`).digest('hex');
}

async function membership(userId, organizationId, activeOnly = true) {
  const row = await db.get(
    `SELECT m.*, u.username, u.email, u.full_name, o.name organization_name, o.slug organization_slug
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=? AND m.organization_id=? ${activeOnly ? "AND m.status='active'" : ''}`,
    [userId, organizationId]
  );
  return row;
}

async function requireMembership(userId, organizationId, roles = null) {
  const item = await membership(userId, organizationId, true);
  if (!item) throw new HttpError(403, 'Active organization membership required');
  if (roles && !roles.includes(item.role)) throw new HttpError(403, 'You do not have permission for this action');
  return item;
}

async function projectWithAccess(userId, projectId, roles = null) {
  const project = await db.get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) throw new HttpError(404, 'Project not found');
  const member = await requireMembership(userId, Number(project.organization_id), roles);
  return { project, member };
}

async function channelWithAccess(userId, channelId, roles = null) {
  const channel = await db.get('SELECT * FROM channels WHERE id=? AND archived=0', [channelId]);
  if (!channel) throw new HttpError(404, 'Channel not found');
  const member = await requireMembership(userId, Number(channel.organization_id), roles);
  return { channel, member };
}

function roleCanInvite(actorRole, proposedRole) {
  if (actorRole === 'ceo') return ['admin', 'moderator', 'member'].includes(proposedRole);
  if (actorRole === 'admin') return ['moderator', 'member'].includes(proposedRole);
  if (actorRole === 'moderator') return proposedRole === 'member';
  return false;
}

async function organizationSummary(userId) {
  return await db.all(
    `SELECT o.*, m.id membership_id, m.role, m.status membership_status
     FROM memberships m JOIN organizations o ON o.id=m.organization_id
     WHERE m.user_id=? ORDER BY o.name`,
    [userId]
  );
}

const PRESENCE_STATUS_SQL = `
  CASE
    WHEN m.status <> 'active' THEN 'offline'
    WHEN COALESCE(p.presence_mode, 'auto') = 'offline' THEN 'offline'
    WHEN COALESCE(p.presence_mode, 'auto') = 'dnd' THEN 'dnd'
    WHEN COALESCE(p.presence_mode, 'auto') = 'away' THEN 'away'
    WHEN p.last_seen_at IS NULL THEN 'offline'
    WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 120 THEN 'online'
    WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 900 THEN 'away'
    ELSE 'offline'
  END`;

async function organizationCeo(organizationId) {
  return await db.get(
    `SELECT u.id user_id,u.username,u.email,u.full_name,u.avatar_url,m.role,m.department,m.status
     FROM memberships m JOIN users u ON u.id=m.user_id
     WHERE m.organization_id=? AND m.role='ceo' AND m.status='active'
     ORDER BY m.id LIMIT 1`,
    [organizationId]
  );
}

async function organizationMembers(organizationId, activeOnly = false) {
  await clearExpiredWorkspaceStatuses();
  return await db.all(
    `SELECT m.id membership_id, m.organization_id, m.user_id, m.role, m.department, m.status, m.joined_at, m.updated_at,
            u.username, u.email, u.full_name, u.avatar_url,
            COALESCE(p.presence_mode, 'auto') presence_mode,
            COALESCE(p.status_key, 'free') status_key,
            COALESCE(p.status_label, 'Free') status_label,
            COALESCE(p.status_emoji, '🟢') status_emoji,
            COALESCE(p.custom_status, '') custom_status,
            p.status_expires_at, p.last_seen_at,
            ${PRESENCE_STATUS_SQL} current_status,
            5 AS capacity
     FROM memberships m
     JOIN users u ON u.id=m.user_id
     LEFT JOIN user_presence p ON p.user_id=u.id
     WHERE m.organization_id=? ${activeOnly ? "AND m.status='active'" : ''}
     ORDER BY CASE m.role WHEN 'ceo' THEN 1 WHEN 'admin' THEN 2 WHEN 'moderator' THEN 3 ELSE 4 END, u.full_name`,
    [organizationId]
  );
}

async function activeOrganizationMembers(organizationId) {
  return await organizationMembers(organizationId, true);
}

async function plannerMembersForOrganization(organizationId) {
  const members = await activeOrganizationMembers(organizationId);
  const workload = await db.all(
    `SELECT t.owner_id,COUNT(*) active_task_count FROM tasks t
     JOIN projects p ON p.id=t.project_id
     WHERE p.organization_id=? AND t.owner_id IS NOT NULL AND t.rejected=0 AND COALESCE(t.archived,0)=0 AND t.status!='done'
     GROUP BY t.owner_id`,
    [organizationId]
  );
  const counts = new Map(workload.map(row => [Number(row.owner_id), Number(row.active_task_count || 0)]));
  return members.map(member => ({ ...member, active_task_count: counts.get(Number(member.user_id)) || 0 }));
}

async function touchPresence(userId) {
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    [userId, 'auto', 'free', 'Free', '🟢', '', null, now, now]
  );
  return await presenceForUser(userId);
}

async function presenceForUser(userId) {
  await clearExpiredWorkspaceStatuses(userId);
  return await db.get(
    `SELECT u.id user_id, COALESCE(p.presence_mode, 'auto') presence_mode,
            COALESCE(p.status_key, 'free') status_key,
            COALESCE(p.status_label, 'Free') status_label,
            COALESCE(p.status_emoji, '🟢') status_emoji,
            COALESCE(p.custom_status, '') custom_status, p.status_expires_at, p.last_seen_at,
            CASE
              WHEN COALESCE(p.presence_mode, 'auto') = 'offline' THEN 'offline'
              WHEN COALESCE(p.presence_mode, 'auto') = 'dnd' THEN 'dnd'
              WHEN COALESCE(p.presence_mode, 'auto') = 'away' THEN 'away'
              WHEN p.last_seen_at IS NULL THEN 'offline'
              WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 120 THEN 'online'
              WHEN (strftime('%s','now') - strftime('%s', p.last_seen_at)) <= 900 THEN 'away'
              ELSE 'offline'
            END current_status
     FROM users u LEFT JOIN user_presence p ON p.user_id=u.id WHERE u.id=?`,
    [userId]
  );
}

async function audit(organizationId, projectId, actorUserId, entityType, entityId, action, details = '') {
  await db.log({ organizationId, projectId, actorUserId, entityType, entityId, action, details });
}

route('GET', '/api/health', async ({ res }) => {
  jsonResponse(res, 200, {
    status: 'ok',
    service: 'flowmate-workspace',
    version: packageJson.version,
    environment: config.nodeEnv,
    uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    external_model_enabled: ai.externalModelEnabled(),
    ai: ai.aiStatus()
  });
}, { auth: false });

route('GET', '/api/health/live', async ({ res }) => {
  jsonResponse(res, 200, { status: 'alive' });
}, { auth: false });

route('GET', '/api/health/ready', async ({ res }) => {
  let ready = false;
  try { ready = await db.healthCheck(); }
  catch (error) { console.error('Database readiness check failed:', error.message); }
  jsonResponse(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'unavailable',
    database_storage: db.storageMode(),
    persistent: db.storageMode() === 'turso',
    local_file_persistent: db.storageMode() === 'local-sqlite',
    persistence_scope: db.storageMode() === 'turso' ? 'cloud' : 'local-machine'
  });
}, { auth: false });

route('GET', '/api/ai/status', async ({ res }) => {
  jsonResponse(res, 200, ai.aiStatus());
});

route('POST', '/api/ai/suggest', async ({ res, user, body }) => {
  const fieldName = cleanString(body.field_name, 120);
  const fieldLabel = cleanString(body.field_label, 160);
  const value = cleanString(body.value, 20000);
  const userInstruction = cleanString(body.instruction, 1000);
  const rawContext = body.form_context && typeof body.form_context === 'object' && !Array.isArray(body.form_context) ? body.form_context : {};
  const formContext = {};
  for (const [key, rawValue] of Object.entries(rawContext).slice(0, 30)) {
    formContext[cleanString(key, 80)] = cleanString(rawValue, 4000);
  }
  let project = null;
  if (body.project_id) {
    const projectId = integer(body.project_id, 'project id');
    const access = await projectWithAccess(user.id, projectId);
    project = {
      id: access.project.id,
      name: access.project.name,
      objective: access.project.objective,
      scope: access.project.scope,
      constraints: access.project.constraints,
      assumptions: access.project.assumptions,
      status: access.project.status
    };
  }
  const result = await ai.suggestField({ fieldName, fieldLabel, value, formContext, project, userInstruction });
  jsonResponse(res, 200, result);
});

route('POST', '/api/auth/register', async ({ req, res, body }) => {
  const username = normalizeUsername(body.username);
  const email = normalizeEmail(body.email);
  const fullName = requiredString(body.full_name, 'Full name', 2, 120);
  const password = validatePassword(body.password);
  const passwordHash = auth.hashPassword(password);
  const now = db.utcnow();

  if (await db.get('SELECT id FROM users WHERE username=? OR email=?', [username, email])) {
    throw new HttpError(409, 'Username or email is already registered');
  }

  let result;
  try {
    result = await db.run(
      'INSERT INTO users(username,email,full_name,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      [username, email, fullName, passwordHash, 'active', now, now]
    );
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'Username or email is already registered');
    throw error;
  }

  await db.run(
    'INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [result.lastInsertRowid, 'auto', 'available', 'Available', '🟢', '', null, now, now]
  );
  await settingsForUser(result.lastInsertRowid);
  const user = await db.get('SELECT * FROM users WHERE id=?', [result.lastInsertRowid]);
  const session = await createAuthSession(user, req);
  await activity(user.id, 'account_created', 'Account created', clientDescription(req));

  jsonResponse(res, 201, {
    token: session.token,
    user: publicUser(user),
    persistent_account: db.storageMode() === 'turso',
    workspace_access: {
      can_access_workspace: false,
      requires_onboarding: true,
      active_organization_count: 0,
      pending_invitation_count: 0
    }
  }, authenticationHeaders(session.token));
}, { auth: false });

route('POST', '/api/auth/login', async ({ req, res, body }) => {
  const identifier = cleanString(body.identifier, 160).toLowerCase();
  if (!identifier) throw new HttpError(400, 'Username or email is required');
  const user = await db.get('SELECT * FROM users WHERE username=? OR email=?', [identifier, identifier]);
  const passwordMatches = auth.verifyPassword(String(body.password || ''), user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) throw new HttpError(401, 'Invalid username/email or password');
  if (user.status !== 'active') throw new HttpError(403, 'This account is disabled');

  const session = await createAuthSession(user, req);
  const presence = await touchPresence(user.id);
  await activity(user.id, 'signed_in', 'Signed in', clientDescription(req));
  jsonResponse(res, 200, {
    token: session.token,
    user: publicUser(user),
    presence,
    settings: await settingsForUser(user.id)
  }, authenticationHeaders(session.token));
}, { auth: false });

route('POST', '/api/auth/forgot-password', async ({ res, body }) => {
  const email = normalizeEmail(body.email);
  const productionNeedsEmail = config.isProduction && !mailer.configured();
  if (productionNeedsEmail) throw new HttpError(503, 'Password recovery email is not configured yet');

  const now = db.utcnow();
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = passwordResetCodeHash(email, code);
  const expiresAt = new Date(Date.now() + config.passwordResetCodeTtlMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const account = await db.get('SELECT * FROM users WHERE email=?', [email]);

  if (account) {
    await db.transaction(async () => {
      await db.run('UPDATE password_reset_codes SET used_at=? WHERE user_id=? AND used_at IS NULL', [now, account.id]);
      await db.run(
        'INSERT INTO password_reset_codes(user_id,code_hash,expires_at,used_at,created_at) VALUES(?,?,?,NULL,?)',
        [account.id, codeHash, expiresAt, now]
      );
    });
  }

  if (account && mailer.configured()) {
    try { await mailer.sendPasswordResetCode({ to: email, code }); }
    catch (error) {
      console.error('Password reset email failed:', error.message);
      throw new HttpError(503, 'Password recovery email could not be sent');
    }
  }

  const payload = { message: 'If an account exists for that email, a reset code has been sent.' };
  if (!config.isProduction && account) payload.dev_reset_code = code;
  jsonResponse(res, 200, payload);
}, { auth: false });

route('POST', '/api/auth/reset-password', async ({ res, body }) => {
  const email = normalizeEmail(body.email);
  const code = cleanString(body.code, 12).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit reset code');
  const newPassword = validatePassword(body.password);
  const codeHash = passwordResetCodeHash(email, code);
  const now = db.utcnow();
  const passwordHash = auth.hashPassword(newPassword);

  const reset = await db.get(
    `SELECT r.id reset_id,u.* FROM password_reset_codes r
     JOIN users u ON u.id=r.user_id
     WHERE u.email=? AND r.code_hash=? AND r.used_at IS NULL AND r.expires_at>?
     ORDER BY r.id DESC LIMIT 1`,
    [email, codeHash, now]
  );
  if (!reset) throw new HttpError(400, 'Reset code is invalid or expired');

  await db.transaction(async () => {
    const consumed = await db.run('UPDATE password_reset_codes SET used_at=? WHERE id=? AND used_at IS NULL', [now, reset.reset_id]);
    if (!consumed.changes) throw new HttpError(400, 'Reset code is invalid or already used');
    await db.run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [passwordHash, now, reset.id]);
    await db.run('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now, reset.id]);
  });
  await activity(reset.id, 'password_reset', 'Password reset', 'Password changed using recovery code');

  jsonResponse(res, 200, { message: 'Password updated. You can sign in with your new password.' });
}, { auth: false });

route('POST', '/api/auth/logout', async ({ req, res, user }) => {
  if (req.authPayload?.sid) await db.run('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND user_id=?', [db.utcnow(), req.authPayload.sid, user.id]);
  await activity(user.id, 'signed_out', 'Signed out', clientDescription(req));
  jsonResponse(res, 200, { status: 'signed_out' }, { 'Set-Cookie': auth.clearSessionCookie() });
});

route('GET', '/api/auth/me', async ({ res, user }) => {
  const presence = await touchPresence(user.id);
  const organizations = await organizationSummary(user.id);
  const activeOrganizationCount = organizations.filter(item => item.membership_status === 'active').length;
  const pendingInvitation = await db.get(
    "SELECT COUNT(*) invitation_count FROM invitations WHERE invited_user_id=? AND status IN ('invited','awaiting_approval')",
    [user.id]
  );
  const settings = await settingsForUser(user.id);
  const unread = await db.get('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
  jsonResponse(res, 200, {
    user: publicUser(user),
    presence,
    settings,
    unread_notification_count: Number(unread?.count || 0),
    organizations,
    workspace_access: {
      can_access_workspace: activeOrganizationCount > 0,
      requires_onboarding: activeOrganizationCount === 0,
      active_organization_count: activeOrganizationCount,
      pending_invitation_count: Number(pendingInvitation?.invitation_count || 0)
    }
  });
});

route('GET', '/api/presence/me', async ({ res, user }) => {
  jsonResponse(res, 200, await presenceForUser(user.id));
});

route('POST', '/api/presence/heartbeat', async ({ res, user }) => {
  jsonResponse(res, 200, await touchPresence(user.id));
});

route('PATCH', '/api/presence/me', async ({ res, user, body }) => {
  const allowedModes = ['auto', 'online', 'away', 'dnd', 'offline'];
  const current = await presenceForUser(user.id);
  const mode = body.presence_mode === undefined ? current.presence_mode : cleanString(body.presence_mode, 20).toLowerCase();
  if (!allowedModes.includes(mode)) throw new HttpError(400, 'Invalid presence mode');
  const selectedStatus = body.status_key === undefined
    ? { key: current.status_key, label: current.status_label, emoji: current.status_emoji }
    : workspaceStatus(body.status_key, body.status_label, body.status_emoji);
  const customStatus = body.custom_status === undefined ? current.custom_status : cleanString(body.custom_status, 120);
  const statusExpiresAt = body.status_expires_at === undefined ? current.status_expires_at : (cleanString(body.status_expires_at, 40) || null);
  if (statusExpiresAt && !Number.isFinite(new Date(statusExpiresAt).getTime())) throw new HttpError(400, 'Status expiry must be a valid date');
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_presence(user_id,presence_mode,status_key,status_label,status_emoji,custom_status,status_expires_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET presence_mode=excluded.presence_mode,status_key=excluded.status_key,status_label=excluded.status_label,status_emoji=excluded.status_emoji,custom_status=excluded.custom_status,status_expires_at=excluded.status_expires_at,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    [user.id, mode, selectedStatus.key, selectedStatus.label, selectedStatus.emoji, customStatus, statusExpiresAt, now, now]
  );
  await activity(user.id, 'status_updated', 'Workspace status updated', `${selectedStatus.emoji} ${selectedStatus.label}${customStatus ? ` — ${customStatus}` : ''}`);
  jsonResponse(res, 200, await presenceForUser(user.id));
});

route('PATCH', '/api/users/me/profile', async ({ res, user, body }) => {
  const updates = [];
  const values = [];
  if (body.full_name !== undefined) { updates.push('full_name=?'); values.push(requiredString(body.full_name, 'Full name', 2, 120)); }
  if (body.avatar_url !== undefined) { updates.push('avatar_url=?'); values.push(validateAvatarUrl(body.avatar_url)); }
  if (!updates.length) throw new HttpError(400, 'No supported profile fields were provided');
  updates.push('updated_at=?'); values.push(db.utcnow(), user.id);
  await db.run(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);
  await activity(user.id, 'profile_updated', 'Profile updated', 'Your name or avatar was updated.');
  jsonResponse(res, 200, publicUser(await db.get('SELECT * FROM users WHERE id=?', [user.id])));
});

route('GET', '/api/users/me/settings', async ({ res, user }) => {
  jsonResponse(res, 200, await settingsForUser(user.id));
});

route('PATCH', '/api/users/me/settings', async ({ res, user, body }) => {
  const current = await settingsForUser(user.id);
  const theme = body.theme === undefined ? current.theme : cleanString(body.theme, 20).toLowerCase();
  if (!['light', 'dark', 'system'].includes(theme)) throw new HttpError(400, 'Theme must be light, dark, or system');
  const preferenceNames = ['workspace_notifications', 'mention_notifications', 'invitation_notifications', 'activity_notifications'];
  const values = { theme };
  for (const name of preferenceNames) values[name] = body[name] === undefined ? Number(current[name]) : booleanInt(Boolean(body[name]));
  const now = db.utcnow();
  await db.run(
    `INSERT INTO user_settings(user_id,theme,workspace_notifications,mention_notifications,invitation_notifications,activity_notifications,updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,workspace_notifications=excluded.workspace_notifications,mention_notifications=excluded.mention_notifications,invitation_notifications=excluded.invitation_notifications,activity_notifications=excluded.activity_notifications,updated_at=excluded.updated_at`,
    [user.id, values.theme, values.workspace_notifications, values.mention_notifications, values.invitation_notifications, values.activity_notifications, now]
  );
  await activity(user.id, 'settings_updated', 'Settings updated', `Theme: ${theme}`);
  jsonResponse(res, 200, await settingsForUser(user.id));
});

route('GET', '/api/users/me/notifications', async ({ res, user, query }) => {
  const requestedLimit = Number(query.get('limit') || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const items = await db.all(
    `SELECT n.*, o.name organization_name FROM notifications n
     LEFT JOIN organizations o ON o.id=n.organization_id
     WHERE n.user_id=? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    [user.id, limit]
  );
  const unread = await db.get('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL', [user.id]);
  jsonResponse(res, 200, { items, unread_count: Number(unread?.count || 0) });
});

route('PATCH', '/api/notifications/:notificationId/read', async ({ res, user, params }) => {
  const notificationId = integer(params.notificationId, 'notification id');
  const item = await db.get('SELECT * FROM notifications WHERE id=? AND user_id=?', [notificationId, user.id]);
  if (!item) throw new HttpError(404, 'Notification not found');
  if (!item.read_at) await db.run('UPDATE notifications SET read_at=? WHERE id=?', [db.utcnow(), notificationId]);
  jsonResponse(res, 200, await db.get('SELECT * FROM notifications WHERE id=?', [notificationId]));
});

route('POST', '/api/users/me/notifications/read-all', async ({ res, user }) => {
  const result = await db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', [db.utcnow(), user.id]);
  jsonResponse(res, 200, { marked_read: result.changes });
});

route('GET', '/api/users/me/activity', async ({ res, user, query }) => {
  const requestedLimit = Number(query.get('limit') || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  const items = await db.all(
    `SELECT a.*, o.name organization_name FROM account_activity a
     LEFT JOIN organizations o ON o.id=a.organization_id
     WHERE a.user_id=? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [user.id, limit]
  );
  jsonResponse(res, 200, items);
});

route('GET', '/api/users/me/sessions', async ({ req, res, user }) => {
  const sessions = (await db.all(
    `SELECT id,ip_address,user_agent,created_at,last_seen_at,expires_at,revoked_at
     FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen_at DESC`,
    [user.id, db.utcnow()]
  )).map(session => ({ ...session, current: session.id === req.authPayload?.sid }));
  jsonResponse(res, 200, sessions);
});

route('DELETE', '/api/users/me/sessions/:sessionId', async ({ req, res, user, params }) => {
  const sessionId = cleanString(params.sessionId, 80);
  const session = await db.get('SELECT * FROM auth_sessions WHERE id=? AND user_id=?', [sessionId, user.id]);
  if (!session) throw new HttpError(404, 'Session not found');
  await db.run('UPDATE auth_sessions SET revoked_at=? WHERE id=?', [db.utcnow(), sessionId]);
  await activity(user.id, 'session_revoked', 'Session signed out', sessionId === req.authPayload?.sid ? 'Current session' : session.user_agent);
  const headers = sessionId === req.authPayload?.sid ? { 'Set-Cookie': auth.clearSessionCookie() } : {};
  jsonResponse(res, 200, { revoked: true, current: sessionId === req.authPayload?.sid }, headers);
});

route('POST', '/api/users/me/sessions/revoke-others', async ({ req, res, user }) => {
  const currentSessionId = req.authPayload?.sid || '';
  const result = await db.run(
    `UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?`,
    [db.utcnow(), user.id, currentSessionId]
  );
  await activity(user.id, 'sessions_revoked', 'Other sessions signed out', `${result.changes} session(s) revoked.`);
  jsonResponse(res, 200, { revoked_count: result.changes });
});

route('GET', '/api/status-presets', async ({ res }) => {
  jsonResponse(res, 200, Object.entries(WORKSPACE_STATUS_PRESETS).map(([key, value]) => ({ key, ...value })));
});

route('GET', '/api/organizations', async ({ res, user }) => {
  jsonResponse(res, 200, await organizationSummary(user.id));
});

route('POST', '/api/organizations', async ({ res, user, body }) => {
  const name = requiredString(body.name, 'Organization name', 2, 120);
  const organization = await createOrganizationForUser(user, name, 'team');
  jsonResponse(res, 201, organization);
});

route('POST', '/api/personal-workspace', async ({ res, user }) => {
  const existing = await db.get(
    `SELECT o.*,m.role,m.status membership_status FROM organizations o
     JOIN memberships m ON m.organization_id=o.id
     WHERE o.created_by=? AND o.workspace_type='personal' AND m.user_id=? AND m.status='active'
     ORDER BY o.id LIMIT 1`,
    [user.id, user.id]
  );
  if (existing) return jsonResponse(res, 200, existing);
  const baseName = `${cleanString(user.full_name, 80) || user.username}'s Personal Workspace`;
  const organization = await createOrganizationForUser(user, baseName, 'personal');
  jsonResponse(res, 201, organization);
});

route('GET', '/api/organizations/:organizationId', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const member = await requireMembership(user.id, organizationId);
  const organization = await db.get('SELECT * FROM organizations WHERE id=?', [organizationId]);
  jsonResponse(res, 200, { ...organization, membership: member });
});

route('GET', '/api/organizations/:organizationId/members', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  jsonResponse(res, 200, await organizationMembers(organizationId, false));
});

route('GET', '/api/invitations/me', async ({ res, user }) => {
  const items = await db.all(
    `SELECT i.*, o.name organization_name, o.slug organization_slug, inviter.full_name invited_by_name
     FROM invitations i JOIN organizations o ON o.id=i.organization_id JOIN users inviter ON inviter.id=i.invited_by
     WHERE i.invited_user_id=? AND i.status IN ('invited','awaiting_approval') ORDER BY i.created_at DESC`,
    [user.id]
  );
  jsonResponse(res, 200, items);
});

route('POST', '/api/organizations/:organizationId/invitations', async ({ req, res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  const actor = await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const identifier = requiredString(body.identifier, 'Username or email', 3, 160).toLowerCase();
  const proposedRole = cleanString(body.proposed_role || 'member', 20).toLowerCase();
  const proposedDepartment = normalizeDepartment(body.proposed_department);
  if (!roleCanInvite(actor.role, proposedRole)) throw new HttpError(403, `A ${actor.role} cannot invite this role`);

  const invitedUser = await db.get('SELECT * FROM users WHERE username=? OR email=?', [identifier, identifier]);
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  if (!invitedUser && !looksLikeEmail) throw new HttpError(404, 'No registered user matches that username. You can invite an unregistered person by email.');
  if (invitedUser && Number(invitedUser.id) === Number(user.id)) throw new HttpError(400, 'You cannot invite yourself');
  if (invitedUser && await membership(invitedUser.id, organizationId, false)) throw new HttpError(409, 'This user already has a membership in the organization');
  if (invitedUser && await db.get("SELECT id FROM invitations WHERE organization_id=? AND invited_user_id=? AND status IN ('invited','awaiting_approval')", [organizationId, invitedUser.id])) throw new HttpError(409, 'An active invitation already exists for this user');

  const organization = await db.get('SELECT * FROM organizations WHERE id=?', [organizationId]);
  const now = db.utcnow();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let invitationId = null;

  await db.transaction(async () => {
    if (invitedUser) {
      const result = await db.run(
        'INSERT INTO invitations(organization_id,invited_user_id,invited_by,proposed_role,proposed_department,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        [organizationId, invitedUser.id, user.id, proposedRole, proposedDepartment, 'invited', now, now]
      );
      invitationId = result.lastInsertRowid;
    }
    await db.run(
      'INSERT INTO workspace_invite_links(organization_id,invited_by,identifier,proposed_role,proposed_department,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [organizationId, user.id, identifier, proposedRole, proposedDepartment, inviteTokenHash(token), expiresAt, now]
    );
  });

  const inviteUrl = `${requestBaseUrl(req)}/?invite=${encodeURIComponent(token)}`;
  await audit(organizationId, null, user.id, 'invitation', invitationId, 'created', { identifier, proposed_role: proposedRole, proposed_department: proposedDepartment, link_created: true });
  if (invitedUser) {
    await notifyUser(invitedUser.id, 'invitation', `Invitation to ${organization.name}`, `${user.full_name} invited you as ${proposedRole} in ${proposedDepartment}.`, organizationId, 'notifications');
  }
  if (looksLikeEmail && mailer.configured()) {
    try { await mailer.sendWorkspaceInvitation({ to: identifier, inviterName: user.full_name, organizationName: organization.name, inviteUrl }); }
    catch (error) { console.error('Workspace invitation email failed:', error.message); }
  }
  await activity(user.id, 'invitation_sent', 'Invitation sent', `Invited ${invitedUser?.full_name || identifier} to ${organization.name}.`, organizationId);
  jsonResponse(res, 201, {
    id: invitationId,
    organization_id: organizationId,
    identifier,
    invited_user_id: invitedUser?.id || null,
    proposed_role: proposedRole,
    proposed_department: proposedDepartment,
    status: 'invited',
    invite_url: inviteUrl,
    expires_at: expiresAt,
    email_delivery: looksLikeEmail ? (mailer.configured() ? 'attempted' : 'smtp_not_configured') : 'not_email'
  });
});

route('POST', '/api/invitations/join', async ({ res, user, body }) => {
  const token = requiredString(body.token, 'Invitation token', 20, 500);
  const now = db.utcnow();
  const link = await db.get(
    `SELECT l.*,o.name organization_name,o.workspace_type
     FROM workspace_invite_links l JOIN organizations o ON o.id=l.organization_id
     WHERE l.token_hash=? AND l.cancelled_at IS NULL AND l.expires_at>?`,
    [inviteTokenHash(token), now]
  );
  if (!link) throw new HttpError(400, 'Invitation link is invalid or expired');

  if (link.used_at) {
    if (Number(link.used_by) !== Number(user.id)) throw new HttpError(409, 'This invitation link has already been used');
    const active = await membership(user.id, Number(link.organization_id), false);
    if (!active || active.status !== 'active') throw new HttpError(409, 'This invitation has already been used');
    return jsonResponse(res, 200, {
      status: 'already_joined',
      organization: (await organizationSummary(user.id)).find(item => Number(item.id) === Number(link.organization_id))
    });
  }

  const identifier = cleanString(link.identifier, 160).toLowerCase();
  if (identifier && identifier !== user.email.toLowerCase() && identifier !== user.username.toLowerCase()) {
    throw new HttpError(403, 'This invitation was sent to a different email or username');
  }

  const existingMembership = await membership(user.id, Number(link.organization_id), false);
  await db.transaction(async () => {
    if (!existingMembership) {
      await db.run(
        'INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        [link.organization_id, user.id, link.proposed_role, normalizeDepartment(link.proposed_department), 'active', now, now]
      );
    } else if (existingMembership.status !== 'active') {
      await db.run("UPDATE memberships SET status='active',role=?,department=?,updated_at=? WHERE id=?", [link.proposed_role, normalizeDepartment(link.proposed_department), now, existingMembership.id]);
    }
    await db.run('UPDATE workspace_invite_links SET used_by=?,used_at=? WHERE id=? AND used_at IS NULL', [user.id, now, link.id]);
    const openInvitation = await db.get("SELECT id FROM invitations WHERE organization_id=? AND invited_user_id=? AND status IN ('invited','awaiting_approval') ORDER BY id DESC LIMIT 1", [link.organization_id, user.id]);
    if (openInvitation) await db.run("UPDATE invitations SET status='approved',user_responded_at=?,approved_at=?,updated_at=? WHERE id=?", [now, now, now, openInvitation.id]);
  });
  await audit(link.organization_id, null, user.id, 'invitation_link', link.id, 'joined', { role: link.proposed_role });
  await activity(user.id, 'membership_joined', 'Joined workspace', link.organization_name, link.organization_id);
  await notifyOrganizationManagers(link.organization_id, 'New workspace member', `${user.full_name} joined via an invitation link.`, user.id);
  jsonResponse(res, 200, {
    status: 'joined',
    organization: (await organizationSummary(user.id)).find(item => Number(item.id) === Number(link.organization_id))
  });
});

route('GET', '/api/organizations/:organizationId/invitations', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const items = await db.all(
    `SELECT i.*, invited.username invited_username, invited.email invited_email, invited.full_name invited_name,
            inviter.full_name invited_by_name, approver.full_name approved_by_name
     FROM invitations i
     JOIN users invited ON invited.id=i.invited_user_id
     JOIN users inviter ON inviter.id=i.invited_by
     LEFT JOIN users approver ON approver.id=i.approved_by
     WHERE i.organization_id=? ORDER BY i.created_at DESC`,
    [organizationId]
  );
  jsonResponse(res, 200, items);
});

route('POST', '/api/invitations/:invitationId/accept', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation || Number(invitation.invited_user_id) !== Number(user.id)) throw new HttpError(404, 'Invitation not found');
  if (invitation.status === 'approved') {
    return jsonResponse(res, 200, { status: 'approved', membership: await membership(user.id, invitation.organization_id, false) });
  }
  if (invitation.status !== 'invited') throw new HttpError(409, 'Invitation cannot be accepted in its current state');
  const now = db.utcnow();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,department=excluded.department,status='active',updated_at=excluded.updated_at`,
      [invitation.organization_id, user.id, invitation.proposed_role, normalizeDepartment(invitation.proposed_department), 'active', now, now]
    );
    await db.run("UPDATE invitations SET status='approved',user_responded_at=?,approved_at=?,updated_at=? WHERE id=?", [now, now, now, invitationId]);
    const invitedAccount = await db.get('SELECT username,email FROM users WHERE id=?', [user.id]);
    await db.run(
      `UPDATE workspace_invite_links SET used_by=?,used_at=?
       WHERE organization_id=? AND used_at IS NULL AND cancelled_at IS NULL AND lower(identifier) IN (?,?)`,
      [user.id, now, invitation.organization_id, invitedAccount.username.toLowerCase(), invitedAccount.email.toLowerCase()]
    );
  });
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'accepted_membership_created', { role: invitation.proposed_role });
  const organization = await db.get('SELECT name FROM organizations WHERE id=?', [invitation.organization_id]);
  await activity(user.id, 'invitation_accepted', 'Joined workspace', organization.name, invitation.organization_id);
  await notifyOrganizationManagers(invitation.organization_id, 'New workspace member', `${user.full_name} accepted an invitation and joined the workspace.`, user.id);
  jsonResponse(res, 200, { status: 'approved', message: `You joined ${organization.name}.`, membership: await membership(user.id, invitation.organization_id, false) });
});

route('POST', '/api/invitations/:invitationId/decline', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation || Number(invitation.invited_user_id) !== Number(user.id)) throw new HttpError(404, 'Invitation not found');
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be declined in its current state');
  await db.run("UPDATE invitations SET status='declined',user_responded_at=?,updated_at=? WHERE id=?", [db.utcnow(), db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'declined');
  await activity(user.id, 'invitation_declined', 'Invitation declined', 'You declined an organization invitation.', invitation.organization_id);
  await notifyUser(invitation.invited_by, 'activity', 'Invitation declined', `${user.full_name} declined the invitation.`, invitation.organization_id, 'admin');
  jsonResponse(res, 200, { status: 'declined' });
});

route('POST', '/api/invitations/:invitationId/approve', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const actor = await requireMembership(user.id, Number(invitation.organization_id), ['ceo', 'admin']);
  if (invitation.status === 'approved') {
    return jsonResponse(res, 200, { status: 'approved', membership: await membership(invitation.invited_user_id, invitation.organization_id, false) });
  }
  if (invitation.status !== 'awaiting_approval') throw new HttpError(409, 'The invitation is not awaiting approval');
  if (!roleCanInvite(actor.role, invitation.proposed_role)) throw new HttpError(403, 'You cannot approve the proposed role');
  const now = db.utcnow();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO memberships(organization_id,user_id,role,department,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,department=excluded.department,status='active',updated_at=excluded.updated_at`,
      [invitation.organization_id, invitation.invited_user_id, invitation.proposed_role, normalizeDepartment(invitation.proposed_department), 'active', now, now]
    );
    await db.run("UPDATE invitations SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=?", [user.id, now, now, invitationId]);
  });
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'approved_membership_created', { role: invitation.proposed_role, department: normalizeDepartment(invitation.proposed_department) });
  const approvedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [invitation.organization_id]);
  await notifyUser(invitation.invited_user_id, 'invitation', `Access approved for ${approvedOrganization.name}`, `Your ${invitation.proposed_role} membership is now active.`, invitation.organization_id, 'dashboard');
  await activity(invitation.invited_user_id, 'membership_approved', 'Organization access approved', approvedOrganization.name, invitation.organization_id);
  await activity(user.id, 'membership_approved', 'Member access approved', `Approved user ${invitation.invited_user_id}.`, invitation.organization_id);
  jsonResponse(res, 200, { status: 'approved', membership: await membership(invitation.invited_user_id, invitation.organization_id, false) });
});

route('POST', '/api/invitations/:invitationId/reject', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  await requireMembership(user.id, Number(invitation.organization_id), ['ceo', 'admin']);
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be rejected in its current state');
  await db.run("UPDATE invitations SET status='rejected',approved_by=?,approved_at=?,updated_at=? WHERE id=?", [user.id, db.utcnow(), db.utcnow(), invitationId]);
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'rejected');
  await notifyUser(invitation.invited_user_id, 'invitation', 'Organization invitation rejected', 'Your request to join was not approved.', invitation.organization_id, 'notifications');
  await activity(invitation.invited_user_id, 'membership_rejected', 'Organization access rejected', 'An organization invitation was rejected.', invitation.organization_id);
  jsonResponse(res, 200, { status: 'rejected' });
});

route('POST', '/api/invitations/:invitationId/cancel', async ({ res, user, params }) => {
  const invitationId = integer(params.invitationId, 'invitation id');
  const invitation = await db.get('SELECT * FROM invitations WHERE id=?', [invitationId]);
  if (!invitation) throw new HttpError(404, 'Invitation not found');
  const actor = await requireMembership(user.id, Number(invitation.organization_id), ['ceo', 'admin', 'moderator']);
  if (!roleCanInvite(actor.role, invitation.proposed_role)) throw new HttpError(403, 'You cannot cancel an invitation for this role');
  if (!['invited', 'awaiting_approval'].includes(invitation.status)) throw new HttpError(409, 'Invitation cannot be cancelled in its current state');
  const now = db.utcnow();
  await db.transaction(async () => {
    await db.run("UPDATE invitations SET status='cancelled',updated_at=? WHERE id=?", [now, invitationId]);
    const invitedAccount = await db.get('SELECT username,email FROM users WHERE id=?', [invitation.invited_user_id]);
    if (invitedAccount) {
      await db.run(
        `UPDATE workspace_invite_links SET cancelled_at=?
         WHERE organization_id=? AND used_at IS NULL AND cancelled_at IS NULL AND lower(identifier) IN (?,?)`,
        [now, invitation.organization_id, invitedAccount.username.toLowerCase(), invitedAccount.email.toLowerCase()]
      );
    }
  });
  await audit(invitation.organization_id, null, user.id, 'invitation', invitationId, 'cancelled');
  await notifyUser(invitation.invited_user_id, 'invitation', 'Invitation cancelled', 'An organization invitation was cancelled by a manager.', invitation.organization_id, 'notifications');
  jsonResponse(res, 200, { status: 'cancelled' });
});

route('PATCH', '/api/memberships/:membershipId', async ({ res, user, params, body }) => {
  const membershipId = integer(params.membershipId, 'membership id');
  const target = await db.get('SELECT * FROM memberships WHERE id=?', [membershipId]);
  if (!target) throw new HttpError(404, 'Membership not found');
  const actor = await requireMembership(user.id, Number(target.organization_id), ['ceo', 'admin']);
  if (target.role === 'ceo') throw new HttpError(403, 'CEO membership cannot be modified');
  const updates = [];
  const values = [];
  if (body.role !== undefined) {
    const role = cleanString(body.role, 20).toLowerCase();
    if (!['admin', 'moderator', 'member'].includes(role)) throw new HttpError(400, 'Invalid role');
    if (actor.role !== 'ceo' && (target.role === 'admin' || role === 'admin')) throw new HttpError(403, 'Only the CEO can manage admin access');
    updates.push('role=?'); values.push(role);
  }
  if (body.department !== undefined) {
    updates.push('department=?'); values.push(normalizeDepartment(body.department));
  }
  if (body.status !== undefined) {
    const status = cleanString(body.status, 20).toLowerCase();
    if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid membership status');
    if (actor.role !== 'ceo' && target.role === 'admin') throw new HttpError(403, 'Only the CEO can suspend an admin');
    updates.push('status=?'); values.push(status);
  }
  if (!updates.length) throw new HttpError(400, 'No supported membership fields were provided');
  updates.push('updated_at=?'); values.push(db.utcnow(), membershipId);
  await db.run(`UPDATE memberships SET ${updates.join(',')} WHERE id=?`, values);
  await audit(target.organization_id, null, user.id, 'membership', membershipId, 'updated', body);
  const updatedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [target.organization_id]);
  await notifyUser(target.user_id, 'activity', 'Membership updated', `Your role, department, or access in ${updatedOrganization.name} changed.`, target.organization_id, 'profile');
  await activity(target.user_id, 'membership_updated', 'Membership updated', updatedOrganization.name, target.organization_id);
  jsonResponse(res, 200, (await organizationMembers(target.organization_id, false)).find(item => Number(item.membership_id) === membershipId));
});

route('DELETE', '/api/memberships/:membershipId', async ({ res, user, params }) => {
  const membershipId = integer(params.membershipId, 'membership id');
  const target = await db.get('SELECT * FROM memberships WHERE id=?', [membershipId]);
  if (!target) throw new HttpError(404, 'Membership not found');
  const actor = await requireMembership(user.id, Number(target.organization_id), ['ceo', 'admin']);
  if (target.role === 'ceo') throw new HttpError(403, 'CEO membership cannot be removed');
  if (actor.role !== 'ceo' && target.role === 'admin') throw new HttpError(403, 'Only the CEO can remove an admin');
  await db.run('DELETE FROM memberships WHERE id=?', [membershipId]);
  await audit(target.organization_id, null, user.id, 'membership', membershipId, 'removed', { user_id: target.user_id });
  const removedOrganization = await db.get('SELECT name FROM organizations WHERE id=?', [target.organization_id]);
  await notifyUser(target.user_id, 'activity', 'Removed from organization', `Your membership in ${removedOrganization.name} was removed.`, target.organization_id, 'notifications');
  await activity(target.user_id, 'membership_removed', 'Organization membership removed', removedOrganization.name, target.organization_id);
  jsonResponse(res, 200, { removed: true });
});

route('GET', '/api/organizations/:organizationId/channels', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const channels = await db.all(
    `SELECT c.*, u.full_name created_by_name,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id) message_count
     FROM channels c JOIN users u ON u.id=c.created_by
     WHERE c.organization_id=? AND c.archived=0 ORDER BY c.name`,
    [organizationId]
  );
  jsonResponse(res, 200, channels);
});

route('POST', '/api/organizations/:organizationId/channels', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Channel name', 2, 60).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
  if (name.length < 2) throw new HttpError(400, 'Channel name must contain letters or numbers');
  const topic = cleanString(body.topic, 240);
  if (await db.get('SELECT id FROM channels WHERE organization_id=? AND name=?', [organizationId, name])) throw new HttpError(409, 'A channel with this name already exists');
  const result = await db.run('INSERT INTO channels(organization_id,name,topic,created_by,created_at) VALUES(?,?,?,?,?)', [organizationId, name, topic, user.id, db.utcnow()]);
  await audit(organizationId, null, user.id, 'channel', result.lastInsertRowid, 'created', { name, topic });
  jsonResponse(res, 201, await db.get('SELECT * FROM channels WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/channels/:channelId/messages', async ({ res, user, params, query }) => {
  const channelId = integer(params.channelId, 'channel id');
  await channelWithAccess(user.id, channelId);
  const before = query.get('before');
  const paramsList = [channelId];
  let condition = '';
  if (before) { condition = 'AND m.id < ?'; paramsList.push(integer(before, 'before')); }
  const items = (await db.all(
    `SELECT m.*,u.username,u.full_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.channel_id=? ${condition} ORDER BY m.id DESC LIMIT 100`,
    paramsList
  )).reverse();
  jsonResponse(res, 200, items);
});

route('GET', '/api/channels/:channelId/events', async ({ req, res, user, params }) => {
  const channelId = integer(params.channelId, 'channel id');
  await channelWithAccess(user.id, channelId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2500\n\n');
  const streams = channelStreamSet(channelId);
  streams.add(res);
  try { req.socket.setKeepAlive(true, 15000); } catch {}

  const recent = (await db.all(
    `SELECT m.*,u.username,u.full_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.channel_id=? ORDER BY m.id DESC LIMIT 100`,
    [channelId]
  )).reverse();
  writeSse(res, 'sync', { messages: recent });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);
  heartbeat.unref?.();
  const cleanup = () => {
    clearInterval(heartbeat);
    removeChannelStream(channelId, res);
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
});

route('POST', '/api/channels/:channelId/messages', async ({ res, user, params, body }) => {
  const channelId = integer(params.channelId, 'channel id');
  const { channel } = await channelWithAccess(user.id, channelId);
  const message = requiredString(body.body, 'Message', 1, 4000);
  const result = await db.run('INSERT INTO messages(channel_id,user_id,body,created_at) VALUES(?,?,?,?)', [channelId, user.id, message, db.utcnow()]);
  await audit(channel.organization_id, null, user.id, 'message', result.lastInsertRowid, 'created', { channel_id: channelId });
  const mentionedUsernames = [...new Set([...message.matchAll(/@([a-z0-9._-]{3,40})/gi)].map(match => match[1].toLowerCase()))];
  for (const username of mentionedUsernames) {
    const mentioned = await db.get(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.username=? AND m.organization_id=? AND m.status='active'`, [username, channel.organization_id]);
    if (mentioned && Number(mentioned.id) !== Number(user.id)) await notifyUser(mentioned.id, 'mention', `${user.full_name} mentioned you`, `#${channel.name}: ${message.slice(0, 180)}`, channel.organization_id, 'chat');
  }
  const created = await db.get('SELECT m.*,u.username,u.full_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?', [result.lastInsertRowid]);
  broadcastChannelEvent(channelId, 'message', created);
  jsonResponse(res, 201, created);
});

async function getProject(projectId) {
  const project = await db.get(
    `SELECT p.*,pm.full_name project_manager_name,pm.username project_manager_username
     FROM projects p LEFT JOIN users pm ON pm.id=p.project_manager_id WHERE p.id=?`,
    [projectId]
  );
  if (!project) throw new HttpError(404, 'Project not found');
  project.team_members = await activeOrganizationMembers(project.organization_id);
  project.sources = await db.all('SELECT * FROM source_records WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  return project;
}

async function taskDetail(taskId) {
  const task = await db.get(
    `SELECT t.*,u.full_name owner_name,u.username owner_username
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id WHERE t.id=?`,
    [taskId]
  );
  if (!task) throw new HttpError(404, 'Task not found');
  task.dependencies = (await db.all('SELECT depends_on_task_id FROM dependencies WHERE task_id=?', [taskId])).map(item => Number(item.depends_on_task_id));
  return task;
}

async function createPlan(projectId, actorUserId, brief = '', replaceUnapproved = false) {
  const project = await getProject(projectId);
  if (replaceUnapproved) await db.run('DELETE FROM tasks WHERE project_id=? AND ai_generated=1 AND approved=0', [projectId]);
  let sourceBrief = cleanString(brief, 20000);
  if (!sourceBrief) {
    const source = await db.get("SELECT content FROM source_records WHERE project_id=? AND record_type='project_brief' ORDER BY id DESC LIMIT 1", [projectId]);
    sourceBrief = source?.content || '';
  }
  if (sourceBrief) await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [projectId, 'plan_input', sourceBrief, actorUserId, db.utcnow()]);
  const members = await activeOrganizationMembers(project.organization_id);
  const aiResult = await ai.generatePlan(project, members, sourceBrief);
  const proposals = aiResult.items;
  const created = await db.transaction(async () => {
    const ids = [];
    for (const proposal of proposals) {
      const inserted = await db.run(
        `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [projectId, proposal.phase, proposal.title, proposal.description, proposal.owner_id, proposal.priority, proposal.status, proposal.progress, proposal.acceptance_criteria, proposal.due_date, 'ai_plan', 1, 0, 0, actorUserId, db.utcnow(), db.utcnow()]
      );
      ids.push(inserted.lastInsertRowid);
    }
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index];
      for (const dependencyIndex of proposal.depends_on_proposal_indexes || []) {
        if (ids[dependencyIndex] && ids[dependencyIndex] !== ids[index]) {
          await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [ids[index], ids[dependencyIndex]]);
        }
      }
    }
    return ids;
  });
  await audit(project.organization_id, projectId, actorUserId, 'project', projectId, 'ai_plan_generated', { created_task_ids: created, provider: aiResult.provider, fallback: aiResult.fallback });
  return { ids: created, aiResult };
}

async function projectReport(projectId) {
  const project = await getProject(projectId);
  const tasks = await db.all(
    `SELECT t.*,u.full_name owner_name FROM tasks t LEFT JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.rejected=0 ORDER BY t.id`,
    [projectId]
  );
  const blockers = tasks.filter(task => task.status === 'blocked');
  const approvedTasks = tasks.filter(task => Number(task.approved) === 1);
  const complete = approvedTasks.filter(task => task.status === 'done');
  const overall = approvedTasks.length ? Math.round(approvedTasks.reduce((sum, task) => sum + Number(task.progress), 0) / approvedTasks.length) : 0;
  return {
    generated_at: db.utcnow(),
    project: { id: project.id, name: project.name, objective: project.objective, scope: project.scope, status: project.status },
    overall_progress_percent: overall,
    approved_task_count: approvedTasks.length,
    completed_task_count: complete.length,
    blockers,
    open_risks: await db.all("SELECT * FROM risks WHERE project_id=? AND status='open' ORDER BY severity DESC,id DESC", [projectId]),
    approved_decisions: await db.all("SELECT * FROM decisions WHERE project_id=? AND status='approved' ORDER BY created_at DESC", [projectId]),
    pending_changes: await db.all("SELECT * FROM changes WHERE project_id=? AND status='pending' ORDER BY created_at DESC", [projectId]),
    recent_updates: await db.all('SELECT * FROM updates WHERE project_id=? ORDER BY created_at DESC LIMIT 20', [projectId]),
    reliability_note: 'Progress, completion, blockers, decisions, and changes are assembled from stored records. AI-generated items remain unapproved until an authorized human reviews them.'
  };
}

async function listProjectsForOrganization(userId, organizationId) {
  await requireMembership(userId, organizationId);
  return await db.all(
    `SELECT p.*,u.full_name created_by_name,pm.full_name project_manager_name,pm.username project_manager_username,
      l.id list_id,l.name list_name,l.space_id,l.folder_id,l.icon list_icon,l.color list_color,
      s.name space_name,f.name folder_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.rejected=0 AND COALESCE(t.archived,0)=0) task_count
     FROM projects p JOIN users u ON u.id=p.created_by
     LEFT JOIN users pm ON pm.id=p.project_manager_id
     LEFT JOIN task_lists l ON l.project_id=p.id AND l.archived=0
     LEFT JOIN spaces s ON s.id=l.space_id
     LEFT JOIN folders f ON f.id=l.folder_id
     WHERE p.organization_id=? ORDER BY p.updated_at DESC,p.id DESC`,
    [organizationId]
  );
}


// -----------------------------------------------------------------------------
// ClickUp-inspired workspace hierarchy and collaboration API (v3.0)
// -----------------------------------------------------------------------------

async function spaceWithAccess(userId, spaceId, roles = null) {
  const space = await db.get('SELECT * FROM spaces WHERE id=?', [spaceId]);
  if (!space) throw new HttpError(404, 'Space not found');
  const member = await requireMembership(userId, Number(space.organization_id), roles);
  return { space, member };
}

async function folderWithAccess(userId, folderId, roles = null) {
  const folder = await db.get(
    `SELECT f.*,s.organization_id,s.name space_name FROM folders f JOIN spaces s ON s.id=f.space_id WHERE f.id=?`,
    [folderId]
  );
  if (!folder) throw new HttpError(404, 'Folder not found');
  const member = await requireMembership(userId, Number(folder.organization_id), roles);
  return { folder, member };
}

async function taskListWithAccess(userId, listId, roles = null) {
  const list = await db.get(
    `SELECT l.*,s.name space_name,f.name folder_name
     FROM task_lists l
     JOIN spaces s ON s.id=l.space_id
     LEFT JOIN folders f ON f.id=l.folder_id
     WHERE l.id=? AND l.archived=0`,
    [listId]
  );
  if (!list) throw new HttpError(404, 'List not found');
  const member = await requireMembership(userId, Number(list.organization_id), roles);
  return { list, member };
}

async function createWorkspaceList({ organizationId, spaceId, folderId = null, userId, name, description = '', icon = '☷', color = '#7b68ee' }) {
  const now = db.utcnow();
  const ceo = await organizationCeo(organizationId);
  const projectManagerId = Number(ceo?.user_id || userId);
  return await db.transaction(async () => {
    const project = await db.run(
      'INSERT INTO projects(organization_id,name,objective,scope,constraints,assumptions,status,project_manager_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [organizationId, name, description, '', '', '', 'active', projectManagerId, userId, now, now]
    );
    const positionRow = await db.get('SELECT COALESCE(MAX(position),0)+1 next_position FROM task_lists WHERE space_id=?', [spaceId]);
    const created = await db.run(
      `INSERT INTO task_lists(organization_id,space_id,folder_id,project_id,name,icon,color,description,position,archived,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [organizationId, spaceId, folderId, project.lastInsertRowid, name, icon, color, description, Number(positionRow?.next_position || 1), userId, now, now]
    );
    return await db.get('SELECT * FROM task_lists WHERE id=?', [created.lastInsertRowid]);
  });
}

function needsConciseBriefProjectName(name) {
  const cleaned = cleanString(name, 500).replace(/[^a-zA-Z0-9&+\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  return words.length > 3 || cleaned.length > 48;
}

async function normalizeLegacyBriefProjectNames(organizationId) {
  const rows = await db.all(
    `SELECT p.id project_id,p.name project_name,l.id list_id,l.name list_name,l.space_id,l.folder_id,
       (SELECT sr.content FROM source_records sr
        WHERE sr.project_id=p.id AND sr.record_type='project_brief'
        ORDER BY sr.id DESC LIMIT 1) brief
     FROM projects p
     JOIN task_lists l ON l.project_id=p.id AND l.archived=0
     WHERE p.organization_id=?`,
    [organizationId]
  );
  for (const row of rows) {
    if (!row.brief || !needsConciseBriefProjectName(row.project_name)) continue;
    const concise = ai.conciseProjectName(row.brief, row.project_name);
    if (!concise || concise.toLowerCase() === cleanString(row.project_name, 160).toLowerCase()) continue;
    const uniqueName = await uniqueListName(Number(row.space_id), row.folder_id ? Number(row.folder_id) : null, concise);
    const now = db.utcnow();
    await db.transaction(async () => {
      await db.run('UPDATE projects SET name=?,updated_at=? WHERE id=?', [uniqueName, now, row.project_id]);
      await db.run('UPDATE task_lists SET name=?,updated_at=? WHERE id=?', [uniqueName, now, row.list_id]);
    });
  }
}

async function ensureWorkspaceHierarchy(organizationId, userId) {
  await requireMembership(userId, organizationId);
  const spaces = await db.all('SELECT * FROM spaces WHERE organization_id=? ORDER BY id', [organizationId]);

  // A fresh workspace intentionally has no automatic Space. The CEO creates the
  // first Space explicitly. Legacy orphan projects are only mapped once a real
  // Space exists, so reading the workspace never creates structure implicitly.
  const fallbackSpace = spaces[0] || null;
  if (fallbackSpace) {
    const orphanProjects = await db.all(
      `SELECT p.* FROM projects p LEFT JOIN task_lists l ON l.project_id=p.id
       WHERE p.organization_id=? AND l.id IS NULL ORDER BY p.id`,
      [organizationId]
    );
    for (const project of orphanProjects) {
      const now = db.utcnow();
      const positionRow = await db.get('SELECT COALESCE(MAX(position),0)+1 next_position FROM task_lists WHERE space_id=?', [fallbackSpace.id]);
      const mapped = await db.run(
        `INSERT INTO task_lists(organization_id,space_id,folder_id,project_id,name,icon,color,description,position,archived,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)`,
        [organizationId, fallbackSpace.id, null, project.id, project.name, '☷', '#7b68ee', project.objective || '', Number(positionRow?.next_position || 1), project.created_by, now, now]
      );
      await db.run('UPDATE tasks SET list_id=? WHERE project_id=? AND list_id IS NULL', [mapped.lastInsertRowid, project.id]);
    }
  }

  // Do not create a demo/default project. A new workspace stays empty until
  // the user explicitly creates a project or commits an AI-generated client brief.
  // Older FlowMate builds could leave a zero-work "Project Management" placeholder
  // behind (sometimes with an auto-created view), so remove that showpiece completely.
  const legacyPlaceholders = await db.all(
    `SELECT p.id project_id,l.id list_id
     FROM projects p
     JOIN task_lists l ON l.project_id=p.id
     WHERE p.organization_id=?
       AND p.name='Project Management'
       AND l.name='Project Management'`,
    [organizationId]
  );
  for (const placeholder of legacyPlaceholders) {
    const taskCount = Number((await db.get('SELECT COUNT(*) count FROM tasks WHERE project_id=?', [placeholder.project_id]))?.count || 0);
    const docCount = Number((await db.get('SELECT COUNT(*) count FROM docs WHERE list_id=?', [placeholder.list_id]))?.count || 0);
    if (taskCount === 0 && docCount === 0) {
      await db.transaction(async () => {
        await db.run('DELETE FROM list_views WHERE list_id=?', [placeholder.list_id]);
        await db.run('DELETE FROM task_lists WHERE id=?', [placeholder.list_id]);
        await db.run('DELETE FROM projects WHERE id=?', [placeholder.project_id]);
      });
    }
  }

  // Older releases also auto-created an empty "Team Space". Remove only the
  // untouched placeholder so existing Spaces that contain real work are preserved.
  const legacySpaces = await db.all(
    `SELECT s.id FROM spaces s
     WHERE s.organization_id=? AND s.name='Team Space'
       AND COALESCE(s.description,'')='Shared team projects and tasks'`,
    [organizationId]
  );
  for (const legacySpace of legacySpaces) {
    const listCount = Number((await db.get('SELECT COUNT(*) count FROM task_lists WHERE space_id=?', [legacySpace.id]))?.count || 0);
    const folderCount = Number((await db.get('SELECT COUNT(*) count FROM folders WHERE space_id=?', [legacySpace.id]))?.count || 0);
    const docCount = Number((await db.get('SELECT COUNT(*) count FROM docs WHERE space_id=?', [legacySpace.id]))?.count || 0);
    if (listCount === 0 && folderCount === 0 && docCount === 0) {
      await db.run('DELETE FROM spaces WHERE id=?', [legacySpace.id]);
    }
  }

  // Older AI-brief projects could use the opening brief sentence as the project
  // name. Keep the full brief in source records, but normalize the visible list/
  // project title to the same concise 2-3 word naming rule used by new projects.
  await normalizeLegacyBriefProjectNames(organizationId);
}

async function workspaceTree(organizationId, userId) {
  await ensureWorkspaceHierarchy(organizationId, userId);
  const spaces = await db.all('SELECT * FROM spaces WHERE organization_id=? ORDER BY id', [organizationId]);
  const folders = await db.all(
    `SELECT f.* FROM folders f JOIN spaces s ON s.id=f.space_id WHERE s.organization_id=? ORDER BY f.id`,
    [organizationId]
  );
  const lists = await db.all(
    `SELECT l.*,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id=l.project_id AND t.rejected=0 AND COALESCE(t.archived,0)=0) task_count
     FROM task_lists l WHERE l.organization_id=? AND l.archived=0 ORDER BY l.position,l.id`,
    [organizationId]
  );
  return spaces.map(space => {
    const spaceFolders = folders.filter(folder => Number(folder.space_id) === Number(space.id)).map(folder => ({
      ...folder,
      lists: lists.filter(list => Number(list.folder_id) === Number(folder.id))
    }));
    return {
      ...space,
      folders: spaceFolders,
      lists: lists.filter(list => Number(list.space_id) === Number(space.id) && !list.folder_id)
    };
  });
}

route('GET', '/api/organizations/:organizationId/workspace-tree', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  jsonResponse(res, 200, await workspaceTree(organizationId, user.id));
});

route('GET', '/api/lists/:listId/views', async ({ res, user, params }) => {
  const listId = integer(params.listId, 'list id');
  await taskListWithAccess(user.id, listId);
  const views = await db.all(
    'SELECT id,list_id,user_id,name,view_type,position,created_at,updated_at FROM list_views WHERE list_id=? AND user_id=? ORDER BY position,id',
    [listId, user.id]
  );
  jsonResponse(res, 200, views);
});

route('POST', '/api/lists/:listId/views', async ({ res, user, params, body }) => {
  const listId = integer(params.listId, 'list id');
  await taskListWithAccess(user.id, listId);
  const name = requiredString(body.name, 'View name', 1, 80);
  const viewType = ['list','board','calendar','dashboard'].includes(body.view_type) ? body.view_type : null;
  if (!viewType) throw new HttpError(400, 'View type must be list, board, calendar, or dashboard');
  const now = db.utcnow();
  const positionRow = await db.get('SELECT COALESCE(MAX(position),0)+1 next_position FROM list_views WHERE list_id=? AND user_id=?', [listId, user.id]);
  let created;
  try {
    created = await db.run('INSERT INTO list_views(list_id,user_id,name,view_type,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [listId,user.id,name,viewType,Number(positionRow?.next_position||1),now,now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message||''))) throw new HttpError(409, 'A view with this name already exists for this project');
    throw error;
  }
  jsonResponse(res, 201, await db.get('SELECT id,list_id,user_id,name,view_type,position,created_at,updated_at FROM list_views WHERE id=?', [created.lastInsertRowid]));
});

route('DELETE', '/api/list-views/:viewId', async ({ res, user, params }) => {
  const viewId = integer(params.viewId, 'view id');
  const view = await db.get('SELECT * FROM list_views WHERE id=?', [viewId]);
  if (!view || Number(view.user_id) !== Number(user.id)) throw new HttpError(404, 'View not found');
  await taskListWithAccess(user.id, Number(view.list_id));
  await db.run('DELETE FROM list_views WHERE id=?', [viewId]);
  jsonResponse(res, 200, { message:'View deleted' });
});

route('POST', '/api/organizations/:organizationId/spaces', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo']);
  const name = requiredString(body.name, 'Space name', 2, 120);
  const now = db.utcnow();
  let result;
  try {
    result = await db.run(
      'INSERT INTO spaces(organization_id,name,icon,color,description,is_private,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [organizationId, name, cleanString(body.icon, 8) || '◫', cleanString(body.color, 20) || '#7b68ee', cleanString(body.description, 1000), booleanInt(body.is_private), user.id, now, now]
    );
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'A Space with this name already exists');
    throw error;
  }
  await audit(organizationId, null, user.id, 'space', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await db.get('SELECT * FROM spaces WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/spaces/:spaceId', async ({ res, user, params, body }) => {
  const spaceId = integer(params.spaceId, 'space id');
  const { space } = await spaceWithAccess(user.id, spaceId, ['ceo', 'admin', 'moderator']);
  const fields = [];
  const values = [];
  if (body.name !== undefined) { fields.push('name=?'); values.push(requiredString(body.name, 'Space name', 2, 120)); }
  if (body.icon !== undefined) { fields.push('icon=?'); values.push(cleanString(body.icon, 8) || '◫'); }
  if (body.color !== undefined) { fields.push('color=?'); values.push(cleanString(body.color, 20) || '#7b68ee'); }
  if (body.description !== undefined) { fields.push('description=?'); values.push(cleanString(body.description, 1000)); }
  if (body.is_private !== undefined) { fields.push('is_private=?'); values.push(booleanInt(body.is_private)); }
  if (!fields.length) throw new HttpError(400, 'No supported Space fields were provided');
  fields.push('updated_at=?'); values.push(db.utcnow(), spaceId);
  await db.run(`UPDATE spaces SET ${fields.join(',')} WHERE id=?`, values);
  await audit(space.organization_id, null, user.id, 'space', spaceId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM spaces WHERE id=?', [spaceId]));
});

route('DELETE', '/api/spaces/:spaceId', async ({ res, user, params }) => {
  const spaceId = integer(params.spaceId, 'space id');
  const { space } = await spaceWithAccess(user.id, spaceId, ['ceo', 'admin']);
  const projectIds = (await db.all('SELECT project_id FROM task_lists WHERE space_id=?', [spaceId])).map(row => Number(row.project_id));
  await db.transaction(async () => {
    for (const projectId of projectIds) await db.run('DELETE FROM projects WHERE id=?', [projectId]);
    await db.run('DELETE FROM spaces WHERE id=?', [spaceId]);
  });
  await audit(space.organization_id, null, user.id, 'space', spaceId, 'deleted');
  jsonResponse(res, 200, { deleted: true });
});

route('POST', '/api/spaces/:spaceId/folders', async ({ res, user, params, body }) => {
  const spaceId = integer(params.spaceId, 'space id');
  const { space } = await spaceWithAccess(user.id, spaceId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Folder name', 2, 120);
  const now = db.utcnow();
  let result;
  try {
    result = await db.run('INSERT INTO folders(space_id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)', [spaceId, name, user.id, now, now]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ''))) throw new HttpError(409, 'A Folder with this name already exists in the Space');
    throw error;
  }
  await audit(space.organization_id, null, user.id, 'folder', result.lastInsertRowid, 'created', { name, space_id: spaceId });
  jsonResponse(res, 201, await db.get('SELECT * FROM folders WHERE id=?', [result.lastInsertRowid]));
});

route('PATCH', '/api/folders/:folderId', async ({ res, user, params, body }) => {
  const folderId = integer(params.folderId, 'folder id');
  const { folder } = await folderWithAccess(user.id, folderId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Folder name', 2, 120);
  await db.run('UPDATE folders SET name=?,updated_at=? WHERE id=?', [name, db.utcnow(), folderId]);
  await audit(folder.organization_id, null, user.id, 'folder', folderId, 'updated', { name });
  jsonResponse(res, 200, await db.get('SELECT * FROM folders WHERE id=?', [folderId]));
});

route('DELETE', '/api/folders/:folderId', async ({ res, user, params }) => {
  const folderId = integer(params.folderId, 'folder id');
  const { folder } = await folderWithAccess(user.id, folderId, ['ceo', 'admin']);
  const projectIds = (await db.all('SELECT project_id FROM task_lists WHERE folder_id=?', [folderId])).map(row => Number(row.project_id));
  await db.transaction(async () => {
    for (const projectId of projectIds) await db.run('DELETE FROM projects WHERE id=?', [projectId]);
    await db.run('DELETE FROM folders WHERE id=?', [folderId]);
  });
  await audit(folder.organization_id, null, user.id, 'folder', folderId, 'deleted');
  jsonResponse(res, 200, { deleted: true });
});

async function handleCreateWorkspaceList({ res, user, body, spaceId, folderId = null }) {
  const { space } = await spaceWithAccess(user.id, spaceId, ['ceo', 'admin', 'moderator']);
  if (folderId) {
    const { folder } = await folderWithAccess(user.id, folderId, ['ceo', 'admin', 'moderator']);
    if (Number(folder.space_id) !== Number(spaceId)) throw new HttpError(400, 'Folder does not belong to this Space');
  }
  const name = requiredString(body.name, 'List name', 2, 160);
  const created = await createWorkspaceList({
    organizationId: Number(space.organization_id),
    spaceId,
    folderId,
    userId: user.id,
    name,
    description: cleanString(body.description, 1000),
    icon: cleanString(body.icon, 8) || '☷',
    color: cleanString(body.color, 20) || '#7b68ee'
  });
  await audit(space.organization_id, created.project_id, user.id, 'list', created.id, 'created', { name, space_id: spaceId, folder_id: folderId });
  jsonResponse(res, 201, created);
}

route('POST', '/api/spaces/:spaceId/lists', async context => {
  const spaceId = integer(context.params.spaceId, 'space id');
  await handleCreateWorkspaceList({ ...context, spaceId });
});

route('POST', '/api/folders/:folderId/lists', async context => {
  const folderId = integer(context.params.folderId, 'folder id');
  const { folder } = await folderWithAccess(context.user.id, folderId, ['ceo', 'admin', 'moderator']);
  await handleCreateWorkspaceList({ ...context, spaceId: Number(folder.space_id), folderId });
});

route('GET', '/api/lists/:listId', async ({ res, user, params }) => {
  const listId = integer(params.listId, 'list id');
  const { list } = await taskListWithAccess(user.id, listId);
  jsonResponse(res, 200, list);
});

route('PATCH', '/api/lists/:listId', async ({ res, user, params, body }) => {
  const listId = integer(params.listId, 'list id');
  const { list } = await taskListWithAccess(user.id, listId, ['ceo', 'admin', 'moderator']);
  const fields = [];
  const values = [];
  if (body.name !== undefined) { fields.push('name=?'); values.push(requiredString(body.name, 'List name', 2, 160)); }
  if (body.description !== undefined) { fields.push('description=?'); values.push(cleanString(body.description, 1000)); }
  if (body.icon !== undefined) { fields.push('icon=?'); values.push(cleanString(body.icon, 8) || '☷'); }
  if (body.color !== undefined) { fields.push('color=?'); values.push(cleanString(body.color, 20) || '#7b68ee'); }
  if (body.position !== undefined) { fields.push('position=?'); values.push(Math.max(0, Math.round(Number(body.position) || 0))); }
  if (!fields.length) throw new HttpError(400, 'No supported List fields were provided');
  fields.push('updated_at=?'); values.push(db.utcnow(), listId);
  await db.run(`UPDATE task_lists SET ${fields.join(',')} WHERE id=?`, values);
  if (body.name !== undefined || body.description !== undefined) {
    await db.run('UPDATE projects SET name=COALESCE(?,name),objective=COALESCE(?,objective),updated_at=? WHERE id=?', [body.name !== undefined ? requiredString(body.name, 'List name', 2, 160) : null, body.description !== undefined ? cleanString(body.description, 1000) : null, db.utcnow(), list.project_id]);
  }
  await audit(list.organization_id, list.project_id, user.id, 'list', listId, 'updated', body);
  jsonResponse(res, 200, (await taskListWithAccess(user.id, listId)).list);
});

route('DELETE', '/api/lists/:listId', async ({ res, user, params }) => {
  const listId = integer(params.listId, 'list id');
  const { list } = await taskListWithAccess(user.id, listId, ['ceo', 'admin']);
  await db.run('DELETE FROM projects WHERE id=?', [list.project_id]);
  await audit(list.organization_id, list.project_id, user.id, 'list', listId, 'deleted');
  jsonResponse(res, 200, { deleted: true });
});

async function tasksForProject(projectId) {
  return await db.all(
    `SELECT t.*,u.full_name owner_name,u.username owner_username,u.avatar_url owner_avatar,
       (SELECT COUNT(*) FROM task_comments c WHERE c.task_id=t.id) comment_count,
       (SELECT COALESCE(SUM(te.duration_seconds),0) FROM time_entries te WHERE te.task_id=t.id) tracked_seconds
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.rejected=0 AND COALESCE(t.archived,0)=0
     ORDER BY CASE t.status WHEN 'in_progress' THEN 1 WHEN 'not_started' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,t.sort_order,t.id`,
    [projectId]
  );
}

route('GET', '/api/lists/:listId/tasks', async ({ res, user, params }) => {
  const listId = integer(params.listId, 'list id');
  const { list } = await taskListWithAccess(user.id, listId);
  const tasks = await tasksForProject(Number(list.project_id));
  jsonResponse(res, 200, tasks);
});

route('POST', '/api/lists/:listId/tasks', async ({ res, user, params, body }) => {
  const listId = integer(params.listId, 'list id');
  const { list } = await taskListWithAccess(user.id, listId);
  const title = requiredString(body.title, 'Task title', 1, 220);
  const parentTaskId = body.parent_task_id ? integer(body.parent_task_id, 'parent_task_id') : null;
  if (parentTaskId) {
    const parent = await db.get('SELECT id,project_id,list_id,parent_task_id FROM tasks WHERE id=? AND rejected=0 AND COALESCE(archived,0)=0', [parentTaskId]);
    if (!parent || Number(parent.project_id) !== Number(list.project_id) || (parent.list_id && Number(parent.list_id) !== Number(list.id))) {
      throw new HttpError(400, 'Parent task must belong to the same List');
    }
  }
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, list.organization_id, true)) throw new HttpError(400, 'Task assignee must be an active workspace member');
  const normalizedPriority = body.priority === 'urgent' ? 'critical' : body.priority;
  const priority = ['low', 'medium', 'high', 'critical'].includes(normalizedPriority) ? normalizedPriority : 'medium';
  const status = ['not_started', 'in_progress', 'blocked', 'done'].includes(body.status) ? body.status : 'not_started';
  const progress = status === 'done' ? 100 : Math.min(100, Math.max(0, Number(body.progress || 0)));
  const now = db.utcnow();
  const sortRow = await db.get('SELECT COALESCE(MAX(sort_order),0)+1 next_sort FROM tasks WHERE project_id=?', [list.project_id]);
  const result = await db.run(
    `INSERT INTO tasks(project_id,list_id,parent_task_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,start_date,due_date,estimate_minutes,sort_order,archived,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [list.project_id, list.id, parentTaskId, cleanString(body.phase, 120) || 'General', title, cleanString(body.description, 20000), ownerId, priority, status, progress, cleanString(body.acceptance_criteria, 10000), cleanString(body.start_date, 10) || null, cleanString(body.due_date, 10) || null, Math.max(0, Math.round(Number(body.estimate_minutes) || 0)), Number(sortRow?.next_sort || 1), 0, 'manual', 0, 1, 0, user.id, now, now]
  );
  await audit(list.organization_id, list.project_id, user.id, 'task', result.lastInsertRowid, 'created', { list_id: list.id, title });
  jsonResponse(res, 201, await taskDetail(result.lastInsertRowid));
});

route('GET', '/api/organizations/:organizationId/tasks', async ({ res, user, params, query }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  await ensureWorkspaceHierarchy(organizationId, user.id);
  const scope = cleanString(query.get('scope'), 20) || 'all';
  const search = cleanString(query.get('search'), 120).toLowerCase();

  // Load the complete workspace task set first so hierarchy depth remains correct even
  // when My Tasks/search filters hide a parent. Use each task's own list_id rather than
  // joining every list in the project (which could duplicate rows in multi-list projects).
  const rows = await db.all(
    `SELECT t.*,u.full_name owner_name,u.username owner_username,u.avatar_url owner_avatar,
       p.name project_name,p.project_manager_id,
       l.id list_id,l.name list_name,s.id space_id,s.name space_name,
       pt.title parent_title,
       (SELECT COUNT(*) FROM task_comments c WHERE c.task_id=t.id) comment_count
     FROM tasks t
     JOIN projects p ON p.id=t.project_id
     LEFT JOIN users u ON u.id=t.owner_id
     LEFT JOIN task_lists l ON l.id=t.list_id
     LEFT JOIN spaces s ON s.id=l.space_id
     LEFT JOIN tasks pt ON pt.id=t.parent_task_id
     WHERE p.organization_id=? AND t.rejected=0 AND COALESCE(t.archived,0)=0
     ORDER BY p.id DESC,t.sort_order,t.id`,
    [organizationId]
  );

  const rowsByProject = new Map();
  for (const row of rows) {
    const key = Number(row.project_id);
    if (!rowsByProject.has(key)) rowsByProject.set(key, []);
    rowsByProject.get(key).push(row);
  }

  const ordered = [];
  for (const projectRows of rowsByProject.values()) {
    const byId = new Map(projectRows.map(row => [Number(row.id), row]));
    const children = new Map();
    const roots = [];
    const siblingSort = (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id);

    for (const row of projectRows) {
      const parentId = row.parent_task_id ? Number(row.parent_task_id) : null;
      if (parentId && byId.has(parentId)) {
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(row);
      } else {
        roots.push(row);
      }
    }
    roots.sort(siblingSort);
    for (const list of children.values()) list.sort(siblingSort);

    const seen = new Set();
    const walk = (row, depth, rootId) => {
      const id = Number(row.id);
      if (seen.has(id)) return;
      seen.add(id);
      ordered.push({
        ...row,
        task_depth: depth,
        task_level: depth === 0 ? 'main' : depth === 1 ? 'subtask' : 'nested',
        root_task_id: Number(rootId || id)
      });
      for (const child of children.get(id) || []) walk(child, depth + 1, rootId || id);
    };
    for (const root of roots) walk(root, 0, Number(root.id));
    // Defensive fallback for malformed/cyclic historical rows: never silently omit them.
    for (const row of projectRows) if (!seen.has(Number(row.id))) walk(row, 0, Number(row.id));
  }

  let result = ordered;
  if (scope === 'me') result = result.filter(row => Number(row.owner_id) === Number(user.id));
  if (search) {
    result = result.filter(row => `${row.title || ''} ${row.description || ''} ${row.project_name || ''} ${row.list_name || ''} ${row.space_name || ''} ${row.parent_title || ''}`.toLowerCase().includes(search));
  }
  jsonResponse(res, 200, result);
});

route('DELETE', '/api/tasks/:taskId', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project } = await projectWithAccess(user.id, Number(task.project_id));
  await db.run('DELETE FROM tasks WHERE id=?', [taskId]);
  await audit(project.organization_id, project.id, user.id, 'task', taskId, 'deleted');
  jsonResponse(res, 200, { deleted: true });
});

route('GET', '/api/tasks/:taskId/comments', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  await projectWithAccess(user.id, Number(task.project_id));
  const comments = await db.all(
    `SELECT c.*,u.full_name,u.username,u.avatar_url FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id`,
    [taskId]
  );
  jsonResponse(res, 200, comments);
});

route('POST', '/api/tasks/:taskId/comments', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project } = await projectWithAccess(user.id, Number(task.project_id));
  const comment = requiredString(body.body, 'Comment', 1, 10000);
  const result = await db.run('INSERT INTO task_comments(task_id,user_id,body,created_at) VALUES(?,?,?,?)', [taskId, user.id, comment, db.utcnow()]);
  await audit(project.organization_id, project.id, user.id, 'task_comment', result.lastInsertRowid, 'created', { task_id: taskId });
  jsonResponse(res, 201, await db.get(`SELECT c.*,u.full_name,u.username,u.avatar_url FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`, [result.lastInsertRowid]));
});

route('GET', '/api/tasks/:taskId/time', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  await projectWithAccess(user.id, Number(task.project_id));
  jsonResponse(res, 200, await db.all(
    `SELECT te.*,u.full_name,u.username FROM time_entries te JOIN users u ON u.id=te.user_id WHERE te.task_id=? ORDER BY te.id DESC`,
    [taskId]
  ));
});

route('POST', '/api/tasks/:taskId/time/start', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  await projectWithAccess(user.id, Number(task.project_id));
  const existing = await db.get('SELECT * FROM time_entries WHERE task_id=? AND user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [taskId, user.id]);
  if (existing) return jsonResponse(res, 200, existing);
  const now = db.utcnow();
  const result = await db.run('INSERT INTO time_entries(task_id,user_id,started_at,ended_at,duration_seconds,note,created_at) VALUES(?,?,?,NULL,0,?,?)', [taskId, user.id, now, cleanString(body.note, 500), now]);
  jsonResponse(res, 201, await db.get('SELECT * FROM time_entries WHERE id=?', [result.lastInsertRowid]));
});

route('POST', '/api/tasks/:taskId/time/stop', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  await projectWithAccess(user.id, Number(task.project_id));
  const existing = await db.get('SELECT * FROM time_entries WHERE task_id=? AND user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', [taskId, user.id]);
  if (!existing) throw new HttpError(409, 'No active timer for this task');
  const endedAt = db.utcnow();
  const duration = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(existing.started_at).getTime()) / 1000));
  await db.run('UPDATE time_entries SET ended_at=?,duration_seconds=? WHERE id=?', [endedAt, duration, existing.id]);
  jsonResponse(res, 200, await db.get('SELECT * FROM time_entries WHERE id=?', [existing.id]));
});

route('GET', '/api/organizations/:organizationId/docs', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  jsonResponse(res, 200, await db.all(
    `SELECT d.*,u.full_name updated_by_name,s.name space_name,l.name list_name
     FROM docs d JOIN users u ON u.id=d.updated_by
     LEFT JOIN spaces s ON s.id=d.space_id LEFT JOIN task_lists l ON l.id=d.list_id
     WHERE d.organization_id=? ORDER BY d.updated_at DESC`,
    [organizationId]
  ));
});

route('POST', '/api/organizations/:organizationId/docs', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  const title = requiredString(body.title, 'Doc title', 1, 200);
  const spaceId = body.space_id ? integer(body.space_id, 'space_id') : null;
  const listId = body.list_id ? integer(body.list_id, 'list_id') : null;
  if (spaceId) { const { space } = await spaceWithAccess(user.id, spaceId); if (Number(space.organization_id) !== organizationId) throw new HttpError(400, 'Space does not belong to this workspace'); }
  if (listId) { const { list } = await taskListWithAccess(user.id, listId); if (Number(list.organization_id) !== organizationId) throw new HttpError(400, 'List does not belong to this workspace'); }
  const now = db.utcnow();
  const result = await db.run('INSERT INTO docs(organization_id,space_id,list_id,title,content,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', [organizationId, spaceId, listId, title, cleanString(body.content, 100000), user.id, user.id, now, now]);
  jsonResponse(res, 201, await db.get('SELECT * FROM docs WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/docs/:docId', async ({ res, user, params }) => {
  const docId = integer(params.docId, 'doc id');
  const doc = await db.get('SELECT * FROM docs WHERE id=?', [docId]);
  if (!doc) throw new HttpError(404, 'Doc not found');
  await requireMembership(user.id, Number(doc.organization_id));
  jsonResponse(res, 200, doc);
});

route('PATCH', '/api/docs/:docId', async ({ res, user, params, body }) => {
  const docId = integer(params.docId, 'doc id');
  const doc = await db.get('SELECT * FROM docs WHERE id=?', [docId]);
  if (!doc) throw new HttpError(404, 'Doc not found');
  await requireMembership(user.id, Number(doc.organization_id));
  const fields = [];
  const values = [];
  if (body.title !== undefined) { fields.push('title=?'); values.push(requiredString(body.title, 'Doc title', 1, 200)); }
  if (body.content !== undefined) { fields.push('content=?'); values.push(cleanString(body.content, 100000)); }
  if (!fields.length) throw new HttpError(400, 'No supported Doc fields were provided');
  fields.push('updated_by=?','updated_at=?'); values.push(user.id, db.utcnow(), docId);
  await db.run(`UPDATE docs SET ${fields.join(',')} WHERE id=?`, values);
  jsonResponse(res, 200, await db.get('SELECT * FROM docs WHERE id=?', [docId]));
});

route('DELETE', '/api/docs/:docId', async ({ res, user, params }) => {
  const docId = integer(params.docId, 'doc id');
  const doc = await db.get('SELECT * FROM docs WHERE id=?', [docId]);
  if (!doc) throw new HttpError(404, 'Doc not found');
  await requireMembership(user.id, Number(doc.organization_id));
  await db.run('DELETE FROM docs WHERE id=?', [docId]);
  jsonResponse(res, 200, { deleted: true });
});

route('GET', '/api/organizations/:organizationId/workspace-dashboard', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId);
  await ensureWorkspaceHierarchy(organizationId, user.id);
  const statusRows = await db.all(
    `SELECT t.status,COUNT(*) count FROM tasks t JOIN projects p ON p.id=t.project_id
     WHERE p.organization_id=? AND t.rejected=0 AND COALESCE(t.archived,0)=0 GROUP BY t.status`,
    [organizationId]
  );
  const priorityRows = await db.all(
    `SELECT t.priority,COUNT(*) count FROM tasks t JOIN projects p ON p.id=t.project_id
     WHERE p.organization_id=? AND t.rejected=0 AND COALESCE(t.archived,0)=0 GROUP BY t.priority`,
    [organizationId]
  );
  const assigneeRows = await db.all(
    `SELECT COALESCE(u.full_name,'Unassigned') name,COUNT(*) count FROM tasks t JOIN projects p ON p.id=t.project_id
     LEFT JOIN users u ON u.id=t.owner_id WHERE p.organization_id=? AND t.rejected=0 AND COALESCE(t.archived,0)=0 AND t.status!='done'
     GROUP BY COALESCE(u.full_name,'Unassigned') ORDER BY count DESC LIMIT 8`,
    [organizationId]
  );
  const dueSoon = await db.all(
    `SELECT t.*,l.id list_id,l.name list_name,u.full_name owner_name FROM tasks t JOIN projects p ON p.id=t.project_id
     LEFT JOIN task_lists l ON l.project_id=p.id LEFT JOIN users u ON u.id=t.owner_id
     WHERE p.organization_id=? AND t.rejected=0 AND COALESCE(t.archived,0)=0 AND t.status!='done' AND t.due_date IS NOT NULL
     ORDER BY t.due_date LIMIT 10`,
    [organizationId]
  );
  const total = statusRows.reduce((sum, row) => sum + Number(row.count), 0);
  const done = Number(statusRows.find(row => row.status === 'done')?.count || 0);
  jsonResponse(res, 200, {
    total_tasks: total,
    completed_tasks: done,
    completion_percent: total ? Math.round(done / total * 100) : 0,
    by_status: statusRows,
    by_priority: priorityRows,
    workload: assigneeRows,
    due_soon: dueSoon
  });
});



function validPlanDate(value) {
  const date = cleanString(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function validPlanPriority(value) {
  const normalized = value === 'urgent' ? 'critical' : cleanString(value, 20).toLowerCase();
  return ['low', 'medium', 'high', 'critical'].includes(normalized) ? normalized : 'medium';
}

async function resolvePlanDestination(userId, organizationId, body = {}) {
  await ensureWorkspaceHierarchy(organizationId, userId);
  let space = null;
  let folder = null;
  if (body.space_id) {
    const access = await spaceWithAccess(userId, integer(body.space_id, 'space_id'), ['ceo', 'admin', 'moderator']);
    if (Number(access.space.organization_id) !== Number(organizationId)) throw new HttpError(400, 'Selected Space is not in this workspace');
    space = access.space;
  } else {
    space = await db.get('SELECT * FROM spaces WHERE organization_id=? ORDER BY id LIMIT 1', [organizationId]);
  }
  if (!space) throw new HttpError(400, 'Create a Space before creating the AI project plan');
  if (body.folder_id) {
    const access = await folderWithAccess(userId, integer(body.folder_id, 'folder_id'), ['ceo', 'admin', 'moderator']);
    if (Number(access.folder.space_id) !== Number(space.id)) throw new HttpError(400, 'Selected Folder is not in the selected Space');
    folder = access.folder;
  }
  return { space, folder };
}

async function uniqueListName(spaceId, folderId, requested) {
  const base = requiredString(requested, 'Project name', 2, 160);
  for (let index = 1; index <= 50; index += 1) {
    const suffix = index === 1 ? '' : ` ${index}`;
    const candidate = `${base.slice(0, Math.max(2, 160 - suffix.length))}${suffix}`;
    const existing = folderId
      ? await db.get('SELECT id FROM task_lists WHERE folder_id=? AND name=? COLLATE NOCASE AND archived=0', [folderId, candidate])
      : await db.get('SELECT id FROM task_lists WHERE space_id=? AND folder_id IS NULL AND name=? COLLATE NOCASE AND archived=0', [spaceId, candidate]);
    if (!existing) return candidate;
  }
  throw new HttpError(409, 'A project with this name already exists in the selected location');
}

function sanitizeReviewedPlan(plan, allowedOwnerIds, brief = '') {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new HttpError(400, 'A reviewed AI plan is required');
  const reviewedProjectName = requiredString(plan.project_name, 'Project name', 2, 160);
  const projectName = ai.conciseProjectName(brief, reviewedProjectName);
  const projectSummary = cleanString(plan.project_summary, 10000);
  const rawMainTasks = Array.isArray(plan.main_tasks) ? plan.main_tasks : [];
  const sanitizeChild = (rawChild, fallbackOwnerId) => {
    const assigneeCandidate = Number(rawChild.assignee_id);
    return {
      title: requiredString(rawChild.title, 'Nested subtask title', 1, 220),
      description: cleanString(rawChild.description, 20000),
      assignee_id: allowedOwnerIds.has(assigneeCandidate) ? assigneeCandidate : (fallbackOwnerId || null),
      priority: validPlanPriority(rawChild.priority),
      acceptance_criteria: cleanString(rawChild.acceptance_criteria, 10000),
      due_date: validPlanDate(rawChild.due_date),
      estimate_minutes: Math.max(0, Math.min(5256000, Math.round(Number(rawChild.estimate_minutes) || 0)))
    };
  };
  const mainTasks = [];
  for (const rawMain of rawMainTasks.slice(0, 6)) {
    if (!rawMain || rawMain.accepted !== true) continue;
    const managerCandidate = Number(rawMain.manager_id);
    const managerId = allowedOwnerIds.has(managerCandidate) ? managerCandidate : null;
    const main = {
      title: requiredString(rawMain.title, 'Main task title', 1, 220),
      description: cleanString(rawMain.description, 20000),
      manager_id: managerId,
      priority: validPlanPriority(rawMain.priority),
      acceptance_criteria: cleanString(rawMain.acceptance_criteria, 10000),
      due_date: validPlanDate(rawMain.due_date),
      estimate_minutes: Math.max(0, Math.min(5256000, Math.round(Number(rawMain.estimate_minutes) || 0))),
      subtasks: []
    };
    for (const rawSub of (Array.isArray(rawMain.subtasks) ? rawMain.subtasks : []).slice(0, 12)) {
      if (!rawSub || rawSub.accepted !== true) continue;
      const assigneeCandidate = Number(rawSub.assignee_id);
      const assigneeId = allowedOwnerIds.has(assigneeCandidate) ? assigneeCandidate : (managerId || null);
      const subtask = {
        title: requiredString(rawSub.title, 'Subtask title', 1, 220),
        description: cleanString(rawSub.description, 20000),
        assignee_id: assigneeId,
        priority: validPlanPriority(rawSub.priority),
        acceptance_criteria: cleanString(rawSub.acceptance_criteria, 10000),
        due_date: validPlanDate(rawSub.due_date),
        estimate_minutes: Math.max(0, Math.min(5256000, Math.round(Number(rawSub.estimate_minutes) || 0))),
        complexity: ['small', 'medium', 'heavy'].includes(rawSub.complexity) ? rawSub.complexity : 'medium',
        child_tasks: []
      };
      for (const rawChild of (Array.isArray(rawSub.child_tasks) ? rawSub.child_tasks : []).slice(0, 8)) {
        if (!rawChild || rawChild.accepted !== true) continue;
        subtask.child_tasks.push(sanitizeChild(rawChild, assigneeId || managerId || null));
      }
      main.subtasks.push(subtask);
    }
    mainTasks.push(main);
  }
  if (!mainTasks.length) throw new HttpError(400, 'Accept at least one main task before creating the project');
  return { project_name: projectName, project_summary: projectSummary, main_tasks: mainTasks };
}


route('POST', '/api/organizations/:organizationId/brief-files/extract', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'File name', 1, 240);
  const extension = path.extname(name).toLowerCase();
  if (!['.pdf','.docx'].includes(extension)) throw new HttpError(400, 'Server extraction supports PDF and DOCX files');
  const encoded = requiredString(body.data, 'File data', 20, 7_500_000);
  let buffer;
  try { buffer = Buffer.from(encoded, 'base64'); } catch { throw new HttpError(400, 'Invalid uploaded file data'); }
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new HttpError(413, 'Brief files must be 5 MB or smaller');
  let text = '';
  try {
    if (extension === '.pdf') {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      text = String(parsed?.text || '');
    } else {
      const mammoth = require('mammoth');
      const parsed = await mammoth.extractRawText({ buffer });
      text = String(parsed?.value || '');
    }
  } catch (error) {
    console.error('Brief file extraction failed:', error.message);
    throw new HttpError(422, 'Could not extract readable text from this file');
  }
  text = text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new HttpError(422, 'No readable text was found in this file');
  jsonResponse(res, 200, { name, text: text.slice(0, 45000), characters: Math.min(text.length, 45000) });
});

route('POST', '/api/organizations/:organizationId/ai-project-plan/regenerate-item', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const level = cleanString(body.level, 20).toLowerCase();
  if (!['main','sub','child'].includes(level)) throw new HttpError(400, 'Invalid plan item level');
  const brief = requiredString(body.brief, 'Project brief', 10, 50000);
  if (!body.item || typeof body.item !== 'object' || Array.isArray(body.item)) throw new HttpError(400, 'Plan item is required');
  const members = await plannerMembersForOrganization(organizationId);
  const result = await ai.regenerateProjectBlueprintItem({ level, item:body.item, parentMain:body.parent_main||null, parentSub:body.parent_sub||null, brief, members });
  const reviewMembers = members.map(member => ({
    user_id:Number(member.user_id), full_name:member.full_name, username:member.username, role:member.role, department:member.department,
    current_status:member.current_status, status_key:member.status_key, status_label:member.status_label, status_emoji:member.status_emoji,
    custom_status:member.custom_status, active_task_count:Number(member.active_task_count||0), capacity:Number(member.capacity||5)
  }));
  await audit(organizationId, null, user.id, 'ai_project_plan', null, 'item_regenerated', { level, provider:result.provider, fallback:result.fallback });
  jsonResponse(res, 200, { item:result.item, members:reviewMembers, ai_provider:result.provider, fallback_used:result.fallback, warning:result.warning||null });
});

route('POST', '/api/organizations/:organizationId/ai-project-plan/preview', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const brief = requiredString(body.brief, 'Project brief', 10, 50000);
  const members = await plannerMembersForOrganization(organizationId);
  const organization = await db.get('SELECT id,name,workspace_type FROM organizations WHERE id=?', [organizationId]);
  const ceo = await organizationCeo(organizationId);
  const result = await ai.generateProjectBlueprint(brief, members, {
    organization_name: organization?.name || 'Workspace',
    workspace_type: organization?.workspace_type || 'team'
  });
  const reviewMembers = members.map(member => ({
    user_id: Number(member.user_id),
    full_name: member.full_name,
    username: member.username,
    role: member.role,
    department: member.department,
    current_status: member.current_status,
    status_key: member.status_key,
    status_label: member.status_label,
    status_emoji: member.status_emoji,
    custom_status: member.custom_status,
    active_task_count: Number(member.active_task_count || 0),
    capacity: Number(member.capacity || 5)
  }));
  await audit(organizationId, null, user.id, 'ai_project_plan', null, 'preview_generated', { provider: result.provider, fallback: result.fallback, main_task_count: result.plan.main_tasks.length });
  jsonResponse(res, 200, {
    plan: result.plan,
    project_manager: ceo ? { user_id:Number(ceo.user_id), full_name:ceo.full_name, username:ceo.username, role:'ceo', department:ceo.department || 'Leadership' } : null,
    members: reviewMembers,
    ai_provider: result.provider,
    fallback_used: result.fallback,
    warning: result.warning || null
  });
});

route('POST', '/api/organizations/:organizationId/ai-project-plan/commit', async ({ res, user, params, body }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const brief = requiredString(body.brief, 'Project brief', 10, 50000);
  const members = await plannerMembersForOrganization(organizationId);
  const allowedOwnerIds = new Set(members.map(member => Number(member.user_id)));
  const plan = sanitizeReviewedPlan(body.plan, allowedOwnerIds, brief);
  const ceo = await organizationCeo(organizationId);
  const { space, folder } = await resolvePlanDestination(user.id, organizationId, body);
  const listName = await uniqueListName(Number(space.id), folder ? Number(folder.id) : null, plan.project_name);
  let createdList = null;
  try {
    createdList = await createWorkspaceList({
      organizationId,
      spaceId: Number(space.id),
      folderId: folder ? Number(folder.id) : null,
      userId: user.id,
      name: listName,
      description: plan.project_summary,
      icon: '✦',
      color: '#7b68ee'
    });
    const now = db.utcnow();
    await db.run('UPDATE projects SET objective=?,scope=?,updated_at=? WHERE id=?', [plan.project_summary, brief, now, createdList.project_id]);
    await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [createdList.project_id, 'project_brief', brief, user.id, now]);
    let sortOrder = 0;
    const createdTaskIds = [];
    let directSubtaskCount = 0;
    let nestedSubtaskCount = 0;
    const insertPlanTask = async ({ parentTaskId, phase, title, description, ownerId, priority, acceptanceCriteria, dueDate, estimateMinutes }) => {
      sortOrder += 1;
      const inserted = await db.run(
        `INSERT INTO tasks(project_id,list_id,parent_task_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,start_date,due_date,estimate_minutes,sort_order,archived,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [createdList.project_id, createdList.id, parentTaskId, phase, title, description, ownerId, priority, 'not_started', 0, acceptanceCriteria, null, dueDate, estimateMinutes, sortOrder, 0, 'ai_project_plan', 1, 1, 0, user.id, now, now]
      );
      const taskId = Number(inserted.lastInsertRowid);
      createdTaskIds.push(taskId);
      return taskId;
    };
    await db.transaction(async () => {
      for (const main of plan.main_tasks) {
        const mainId = await insertPlanTask({
          parentTaskId: null,
          phase: 'Main Task',
          title: main.title,
          description: main.description,
          ownerId: main.manager_id,
          priority: main.priority,
          acceptanceCriteria: main.acceptance_criteria,
          dueDate: main.due_date,
          estimateMinutes: main.estimate_minutes
        });
        for (const subtask of main.subtasks) {
          directSubtaskCount += 1;
          const subtaskId = await insertPlanTask({
            parentTaskId: mainId,
            phase: main.title,
            title: subtask.title,
            description: subtask.description,
            ownerId: subtask.assignee_id,
            priority: subtask.priority,
            acceptanceCriteria: subtask.acceptance_criteria,
            dueDate: subtask.due_date,
            estimateMinutes: subtask.estimate_minutes
          });
          for (const child of subtask.child_tasks || []) {
            nestedSubtaskCount += 1;
            await insertPlanTask({
              parentTaskId: subtaskId,
              phase: `${main.title} / ${subtask.title}`,
              title: child.title,
              description: child.description,
              ownerId: child.assignee_id,
              priority: child.priority,
              acceptanceCriteria: child.acceptance_criteria,
              dueDate: child.due_date,
              estimateMinutes: child.estimate_minutes
            });
          }
        }
      }
    });
    await audit(organizationId, createdList.project_id, user.id, 'ai_project_plan', createdList.project_id, 'accepted_and_created', {
      list_id: createdList.id,
      main_task_count: plan.main_tasks.length,
      direct_subtask_count: directSubtaskCount,
      nested_subtask_count: nestedSubtaskCount,
      task_count: createdTaskIds.length
    });
    jsonResponse(res, 201, {
      project_id: Number(createdList.project_id),
      list_id: Number(createdList.id),
      project_name: listName,
      project_manager_id: Number(ceo?.user_id || user.id),
      project_manager_name: ceo?.full_name || user.full_name,
      main_task_count: plan.main_tasks.length,
      direct_subtask_count: directSubtaskCount,
      nested_subtask_count: nestedSubtaskCount,
      task_count: createdTaskIds.length,
      created_task_ids: createdTaskIds,
      message: 'Accepted AI plan created with main tasks, managers, detailed subtasks, and nested subtasks for heavy work.'
    });
  } catch (error) {
    if (createdList?.project_id) {
      try { await db.run('DELETE FROM projects WHERE id=?', [createdList.project_id]); } catch {}
    }
    throw error;
  }
});

route('GET', '/api/projects', async ({ res, user, query }) => {
  const organizationId = integer(query.get('organization_id'), 'organization_id');
  jsonResponse(res, 200, await listProjectsForOrganization(user.id, organizationId));
});

route('GET', '/api/organizations/:organizationId/projects', async ({ res, user, params }) => {
  const organizationId = integer(params.organizationId, 'organization id');
  jsonResponse(res, 200, await listProjectsForOrganization(user.id, organizationId));
});

async function handleCreateProject({ res, user, body, organizationId }) {
  await requireMembership(user.id, organizationId, ['ceo', 'admin', 'moderator']);
  const name = requiredString(body.name, 'Project name', 2, 160);
  const now = db.utcnow();
  const ceo = await organizationCeo(organizationId);
  const projectManagerId = Number(ceo?.user_id || user.id);
  const result = await db.run(
    'INSERT INTO projects(organization_id,name,objective,scope,constraints,assumptions,status,project_manager_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [organizationId, name, cleanString(body.objective), cleanString(body.scope), cleanString(body.constraints), cleanString(body.assumptions), 'active', projectManagerId, user.id, now, now]
  );
  const brief = cleanString(body.brief, 20000);
  if (brief) await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [result.lastInsertRowid, 'project_brief', brief, user.id, now]);
  await audit(organizationId, result.lastInsertRowid, user.id, 'project', result.lastInsertRowid, 'created', { name });
  jsonResponse(res, 201, await getProject(result.lastInsertRowid));
}

route('POST', '/api/projects', async context => {
  const organizationId = integer(context.body.organization_id, 'organization_id');
  await handleCreateProject({ ...context, organizationId });
});

route('POST', '/api/organizations/:organizationId/projects', async context => {
  const organizationId = integer(context.params.organizationId, 'organization id');
  await handleCreateProject({ ...context, organizationId });
});

route('GET', '/api/projects/:projectId', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await getProject(projectId));
});

route('POST', '/api/projects/:projectId/generate-plan', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const result = await createPlan(projectId, user.id, body.brief || '', Boolean(body.replace_unapproved));
  jsonResponse(res, 201, { created_task_ids: result.ids, ai_provider: result.aiResult.provider, fallback_used: result.aiResult.fallback, warning: result.aiResult.warning || null, message: 'AI proposals created. Review and approve or edit them.' });
});

route('GET', '/api/projects/:projectId/tasks', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const tasks = await db.all(
    `SELECT t.*,u.full_name owner_name,u.username owner_username
     FROM tasks t LEFT JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.rejected=0 ORDER BY t.phase,t.id`,
    [projectId]
  );
  const dependencies = await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const byTask = new Map();
  for (const item of dependencies) {
    const list = byTask.get(Number(item.task_id)) || [];
    list.push(Number(item.depends_on_task_id));
    byTask.set(Number(item.task_id), list);
  }
  tasks.forEach(task => { task.dependencies = byTask.get(Number(task.id)) || []; });
  jsonResponse(res, 200, tasks);
});

route('POST', '/api/projects/:projectId/tasks', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const title = requiredString(body.title, 'Task title', 2, 220);
  const ownerId = body.owner_id ? integer(body.owner_id, 'owner_id') : null;
  if (ownerId && !await membership(ownerId, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
  const normalizedPriority = body.priority === 'urgent' ? 'critical' : body.priority;
  const priority = ['low', 'medium', 'high', 'critical'].includes(normalizedPriority) ? normalizedPriority : 'medium';
  const status = ['not_started', 'in_progress', 'blocked', 'done'].includes(body.status) ? body.status : 'not_started';
  const progress = Math.min(100, Math.max(0, Number(body.progress || 0)));
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,due_date,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [projectId, cleanString(body.phase, 120) || 'General', title, cleanString(body.description), ownerId, priority, status, progress, cleanString(body.acceptance_criteria), cleanString(body.due_date, 10) || null, 'manual', 0, 1, 0, user.id, now, now]
  );
  for (const dependencyId of Array.isArray(body.dependencies) ? body.dependencies : []) {
    const dep = integer(dependencyId, 'dependency id');
    if (dep !== result.lastInsertRowid && await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [dep, projectId])) await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [result.lastInsertRowid, dep]);
  }
  await audit(project.organization_id, projectId, user.id, 'task', result.lastInsertRowid, 'created', body);
  jsonResponse(res, 201, await taskDetail(result.lastInsertRowid));
});

route('GET', '/api/tasks/:taskId', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  await projectWithAccess(user.id, Number(task.project_id));
  jsonResponse(res, 200, task);
});

route('PATCH', '/api/tasks/:taskId', async ({ res, user, params, body }) => {
  const taskId = integer(params.taskId, 'task id');
  const existing = await taskDetail(taskId);
  const { project, member } = await projectWithAccess(user.id, Number(existing.project_id));
  if ((body.approved !== undefined || body.rejected !== undefined) && !['ceo', 'admin', 'moderator'].includes(member.role)) throw new HttpError(403, 'Only CEO, admin, or moderator can approve/reject AI work');
  const allowed = {
    phase: value => cleanString(value, 120) || 'General',
    title: value => requiredString(value, 'Task title', 2, 220),
    description: value => cleanString(value),
    owner_id: value => value ? integer(value, 'owner_id') : null,
    priority: value => { const normalized = value === 'urgent' ? 'critical' : value; if (!['low', 'medium', 'high', 'critical'].includes(normalized)) throw new HttpError(400, 'Invalid priority'); return normalized; },
    status: value => { if (!['not_started', 'in_progress', 'blocked', 'done'].includes(value)) throw new HttpError(400, 'Invalid status'); return value; },
    progress: value => { const output = Number(value); if (!Number.isFinite(output) || output < 0 || output > 100) throw new HttpError(400, 'Progress must be between 0 and 100'); return Math.round(output); },
    acceptance_criteria: value => cleanString(value),
    start_date: value => cleanString(value, 10) || null,
    due_date: value => cleanString(value, 10) || null,
    estimate_minutes: value => { const output = Number(value); if (!Number.isFinite(output) || output < 0 || output > 5256000) throw new HttpError(400, 'Invalid time estimate'); return Math.round(output); },
    sort_order: value => { const output = Number(value); if (!Number.isFinite(output)) throw new HttpError(400, 'Invalid task order'); return output; },
    archived: value => booleanInt(value),
    approved: value => booleanInt(value),
    rejected: value => booleanInt(value)
  };
  const fields = [];
  const values = [];
  for (const [key, transform] of Object.entries(allowed)) {
    if (body[key] !== undefined) {
      const value = transform(body[key]);
      if (key === 'owner_id' && value && !await membership(value, project.organization_id, true)) throw new HttpError(400, 'Task owner must be an active organization member');
      fields.push(`${key}=?`); values.push(value);
    }
  }
  if (body.status === 'done' && body.progress === undefined) { fields.push('progress=?'); values.push(100); }
  if (body.status && body.status !== 'done' && body.progress === undefined && Number(existing.progress) === 100) { fields.push('progress=?'); values.push(0); }
  if (fields.length) {
    fields.push('updated_at=?'); values.push(db.utcnow(), taskId);
    await db.run(`UPDATE tasks SET ${fields.join(',')} WHERE id=?`, values);
  }
  if (Array.isArray(body.dependencies)) {
    await db.run('DELETE FROM dependencies WHERE task_id=?', [taskId]);
    for (const dependencyId of body.dependencies) {
      const dep = integer(dependencyId, 'dependency id');
      if (dep !== taskId && await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [dep, existing.project_id])) await db.run('INSERT OR IGNORE INTO dependencies(task_id,depends_on_task_id) VALUES(?,?)', [taskId, dep]);
    }
  }
  await audit(project.organization_id, existing.project_id, user.id, 'task', taskId, 'updated', body);
  jsonResponse(res, 200, await taskDetail(taskId));
});

route('POST', '/api/tasks/:taskId/regenerate', async ({ res, user, params }) => {
  const taskId = integer(params.taskId, 'task id');
  const task = await taskDetail(taskId);
  const { project } = await projectWithAccess(user.id, Number(task.project_id), ['ceo', 'admin', 'moderator']);
  const aiResult = await ai.regenerateTask(task, project, await activeOrganizationMembers(project.organization_id));
  await db.run('UPDATE tasks SET description=?,acceptance_criteria=?,approved=0,rejected=0,ai_generated=1,updated_at=? WHERE id=?', [aiResult.item.description, aiResult.item.acceptance_criteria, db.utcnow(), taskId]);
  await audit(project.organization_id, task.project_id, user.id, 'task', taskId, 'ai_regenerated', { provider: aiResult.provider, fallback: aiResult.fallback });
  const updated = await taskDetail(taskId);
  updated.ai_provider = aiResult.provider;
  updated.fallback_used = aiResult.fallback;
  jsonResponse(res, 200, updated);
});

route('POST', '/api/projects/:projectId/meeting-notes', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const notes = requiredString(body.notes, 'Meeting notes', 5, 30000);
  await db.run('INSERT INTO source_records(project_id,record_type,content,created_by,created_at) VALUES(?,?,?,?,?)', [projectId, 'meeting_notes', notes, user.id, db.utcnow()]);
  const aiResult = await ai.generateMeetingSuggestions(notes, await activeOrganizationMembers(project.organization_id), project);
  const proposals = aiResult.items;
  const ids = [];
  for (const proposal of proposals) {
    const inserted = await db.run(
      'INSERT INTO suggestions(project_id,suggestion_type,payload_json,rationale,evidence,status,created_at) VALUES(?,?,?,?,?,?,?)',
      [projectId, proposal.suggestion_type, JSON.stringify(proposal.payload), proposal.rationale, proposal.evidence, 'pending', db.utcnow()]
    );
    ids.push(inserted.lastInsertRowid);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'meeting_notes_processed', { suggestion_ids: ids, provider: aiResult.provider, fallback: aiResult.fallback });
  jsonResponse(res, 201, { created_suggestion_ids: ids, ai_provider: aiResult.provider, fallback_used: aiResult.fallback, message: 'Meeting-note proposals created for review.' });
});

route('GET', '/api/projects/:projectId/suggestions', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const items = await db.all('SELECT * FROM suggestions WHERE project_id=? ORDER BY created_at DESC', [projectId]);
  items.forEach(item => {
    try { item.payload = JSON.parse(item.payload_json); } catch { item.payload = {}; }
  });
  jsonResponse(res, 200, items);
});

route('POST', '/api/suggestions/:suggestionId/approve', async ({ res, user, params }) => {
  const suggestionId = integer(params.suggestionId, 'suggestion id');
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id=?', [suggestionId]);
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  const { project } = await projectWithAccess(user.id, Number(suggestion.project_id), ['ceo', 'admin', 'moderator']);
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion has already been reviewed');
  let payload = {};
  try { payload = JSON.parse(suggestion.payload_json); } catch {}
  let createdEntity = null;
  if (suggestion.suggestion_type === 'task') {
    const owner = payload.owner_name ? await db.get(
      `SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.status='active' AND lower(u.full_name)=lower(?) LIMIT 1`,
      [project.organization_id, payload.owner_name]
    ) : null;
    const result = await db.run(
      `INSERT INTO tasks(project_id,phase,title,description,owner_id,priority,status,progress,acceptance_criteria,source_type,ai_generated,approved,rejected,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [suggestion.project_id, payload.phase || 'Meeting Follow-up', payload.title || 'Meeting follow-up', payload.description || '', owner?.id || null, ['low','medium','high','critical'].includes(payload.priority) ? payload.priority : 'medium', 'not_started', 0, payload.acceptance_criteria || '', 'meeting_note', 1, 1, 0, user.id, db.utcnow(), db.utcnow()]
    );
    createdEntity = { type: 'task', id: result.lastInsertRowid };
  } else if (suggestion.suggestion_type === 'decision') {
    const result = await db.run('INSERT INTO decisions(project_id,title,detail,owner,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [suggestion.project_id, payload.title || 'Meeting decision', payload.detail || suggestion.evidence, payload.owner || '', 'approved', 'meeting_note', user.id, db.utcnow()]);
    createdEntity = { type: 'decision', id: result.lastInsertRowid };
  } else if (suggestion.suggestion_type === 'risk') {
    const result = await db.run('INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [suggestion.project_id, payload.risk_type || 'meeting_note', payload.severity || 'medium', payload.title || 'Meeting risk', payload.description || suggestion.evidence, suggestion.evidence, 'open', 1, 1, db.utcnow(), db.utcnow()]);
    createdEntity = { type: 'risk', id: result.lastInsertRowid };
  }
  await db.run("UPDATE suggestions SET status='approved',reviewed_at=?,reviewed_by=? WHERE id=?", [db.utcnow(), user.id, suggestionId]);
  await audit(project.organization_id, suggestion.project_id, user.id, 'suggestion', suggestionId, 'approved', createdEntity || {});
  jsonResponse(res, 200, { status: 'approved', created_entity: createdEntity });
});

route('POST', '/api/suggestions/:suggestionId/reject', async ({ res, user, params }) => {
  const suggestionId = integer(params.suggestionId, 'suggestion id');
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id=?', [suggestionId]);
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  const { project } = await projectWithAccess(user.id, Number(suggestion.project_id), ['ceo', 'admin', 'moderator']);
  if (suggestion.status !== 'pending') throw new HttpError(409, 'Suggestion has already been reviewed');
  await db.run("UPDATE suggestions SET status='rejected',reviewed_at=?,reviewed_by=? WHERE id=?", [db.utcnow(), user.id, suggestionId]);
  await audit(project.organization_id, suggestion.project_id, user.id, 'suggestion', suggestionId, 'rejected');
  jsonResponse(res, 200, { status: 'rejected' });
});

route('POST', '/api/projects/:projectId/risks/scan', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const tasks = await db.all('SELECT * FROM tasks WHERE project_id=? AND rejected=0', [projectId]);
  const dependencies = await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]);
  const aiResult = await ai.scanRisksWithAi(tasks, await activeOrganizationMembers(project.organization_id), dependencies, project);
  const risks = aiResult.items;
  await db.run('DELETE FROM risks WHERE project_id=? AND ai_generated=1 AND approved=0', [projectId]);
  const ids = [];
  for (const item of risks) {
    const inserted = await db.run(
      'INSERT INTO risks(project_id,risk_type,severity,title,description,evidence,status,ai_generated,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [projectId, item.risk_type, item.severity, item.title, item.description, item.evidence, 'open', 1, 0, db.utcnow(), db.utcnow()]
    );
    ids.push(inserted.lastInsertRowid);
  }
  await audit(project.organization_id, projectId, user.id, 'project', projectId, 'risk_scan_completed', { risk_ids: ids, provider: aiResult.provider, fallback: aiResult.fallback });
  jsonResponse(res, 201, { created_risk_ids: ids, count: ids.length, ai_provider: aiResult.provider, fallback_used: aiResult.fallback });
});

route('GET', '/api/projects/:projectId/risks', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await db.all('SELECT * FROM risks WHERE project_id=? ORDER BY status,severity DESC,id DESC', [projectId]));
});

route('PATCH', '/api/risks/:riskId', async ({ res, user, params, body }) => {
  const riskId = integer(params.riskId, 'risk id');
  const risk = await db.get('SELECT * FROM risks WHERE id=?', [riskId]);
  if (!risk) throw new HttpError(404, 'Risk not found');
  const { project } = await projectWithAccess(user.id, Number(risk.project_id), ['ceo', 'admin', 'moderator']);
  const fields = [];
  const values = [];
  if (body.status !== undefined) { fields.push('status=?'); values.push(cleanString(body.status, 30)); }
  if (body.approved !== undefined) { fields.push('approved=?'); values.push(booleanInt(body.approved)); }
  if (!fields.length) throw new HttpError(400, 'No supported risk fields were provided');
  fields.push('updated_at=?'); values.push(db.utcnow(), riskId);
  await db.run(`UPDATE risks SET ${fields.join(',')} WHERE id=?`, values);
  await audit(project.organization_id, risk.project_id, user.id, 'risk', riskId, 'updated', body);
  jsonResponse(res, 200, await db.get('SELECT * FROM risks WHERE id=?', [riskId]));
});

route('POST', '/api/projects/:projectId/changes', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const title = requiredString(body.title, 'Change title', 2, 220);
  const description = requiredString(body.description, 'Change description', 3, 10000);
  const taskCount = Number((await db.get('SELECT COUNT(*) count FROM tasks WHERE project_id=? AND rejected=0', [projectId]))?.count || 0);
  const ownerCounts = Object.fromEntries((await db.all(
    `SELECT u.full_name name,COUNT(*) count FROM tasks t JOIN users u ON u.id=t.owner_id
     WHERE t.project_id=? AND t.status!='done' AND t.rejected=0 GROUP BY u.id,u.full_name`, [projectId]
  )).map(row => [row.name, Number(row.count)]));
  const existingTasks = await db.all('SELECT id,phase,title,owner_id,priority,status,progress,due_date FROM tasks WHERE project_id=? AND rejected=0 ORDER BY id', [projectId]);
  const aiResult = await ai.analyzeChangeWithAi(description, taskCount, ownerCounts, project, existingTasks);
  const impact = aiResult.item;
  const now = db.utcnow();
  const result = await db.run(
    `INSERT INTO changes(project_id,title,description,impact_scope,impact_effort,impact_dependencies,impact_workload,status,requested_by,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [projectId, title, description, impact.impact_scope, impact.impact_effort, impact.impact_dependencies, impact.impact_workload, 'pending', cleanString(body.requested_by, 160), user.id, now, now]
  );
  await audit(project.organization_id, projectId, user.id, 'change', result.lastInsertRowid, 'created', { title, impact, provider: aiResult.provider, fallback: aiResult.fallback });
  const createdChange = await db.get('SELECT * FROM changes WHERE id=?', [result.lastInsertRowid]);
  createdChange.ai_provider = aiResult.provider;
  createdChange.fallback_used = aiResult.fallback;
  jsonResponse(res, 201, createdChange);
});

route('GET', '/api/projects/:projectId/changes', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await db.all('SELECT * FROM changes WHERE project_id=? ORDER BY created_at DESC', [projectId]));
});

route('POST', '/api/changes/:changeId/:action', async ({ res, user, params }) => {
  const changeId = integer(params.changeId, 'change id');
  const action = cleanString(params.action, 20).toLowerCase();
  if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Action must be approve or reject');
  const change = await db.get('SELECT * FROM changes WHERE id=?', [changeId]);
  if (!change) throw new HttpError(404, 'Change not found');
  const { project } = await projectWithAccess(user.id, Number(change.project_id), ['ceo', 'admin', 'moderator']);
  await db.run('UPDATE changes SET status=?,updated_at=? WHERE id=?', [action === 'approve' ? 'approved' : 'rejected', db.utcnow(), changeId]);
  await audit(project.organization_id, change.project_id, user.id, 'change', changeId, action + 'd');
  jsonResponse(res, 200, await db.get('SELECT * FROM changes WHERE id=?', [changeId]));
});

route('POST', '/api/projects/:projectId/decisions', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  const result = await db.run('INSERT INTO decisions(project_id,title,detail,owner,status,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', [projectId, requiredString(body.title, 'Decision title', 2, 220), requiredString(body.detail, 'Decision detail', 3, 10000), cleanString(body.owner, 160), 'approved', 'manual', user.id, db.utcnow()]);
  await audit(project.organization_id, projectId, user.id, 'decision', result.lastInsertRowid, 'created');
  jsonResponse(res, 201, await db.get('SELECT * FROM decisions WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/projects/:projectId/decisions', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await db.all('SELECT * FROM decisions WHERE project_id=? ORDER BY created_at DESC', [projectId]));
});

route('POST', '/api/projects/:projectId/updates', async ({ res, user, params, body }) => {
  const projectId = integer(params.projectId, 'project id');
  const { project } = await projectWithAccess(user.id, projectId);
  const taskId = body.task_id ? integer(body.task_id, 'task_id') : null;
  if (taskId && !await db.get('SELECT id FROM tasks WHERE id=? AND project_id=?', [taskId, projectId])) throw new HttpError(400, 'Task does not belong to this project');
  const result = await db.run('INSERT INTO updates(project_id,task_id,note,update_type,created_by,created_at) VALUES(?,?,?,?,?,?)', [projectId, taskId, requiredString(body.note, 'Update note', 2, 10000), cleanString(body.update_type, 40) || 'progress', user.id, db.utcnow()]);
  await audit(project.organization_id, projectId, user.id, 'update', result.lastInsertRowid, 'created');
  jsonResponse(res, 201, await db.get('SELECT * FROM updates WHERE id=?', [result.lastInsertRowid]));
});

route('GET', '/api/projects/:projectId/report', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  jsonResponse(res, 200, await projectReport(projectId));
});

route('GET', '/api/projects/:projectId/audit', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId, ['ceo', 'admin', 'moderator']);
  jsonResponse(res, 200, await db.all(
    `SELECT a.*,u.full_name actor_name,u.username actor_username FROM audit_log a
     LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.project_id=? ORDER BY a.id DESC LIMIT 500`,
    [projectId]
  ));
});

route('GET', '/api/projects/:projectId/export.json', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const exportData = {
    project: await getProject(projectId),
    tasks: await db.all('SELECT * FROM tasks WHERE project_id=?', [projectId]),
    dependencies: await db.all('SELECT d.* FROM dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.project_id=?', [projectId]),
    risks: await db.all('SELECT * FROM risks WHERE project_id=?', [projectId]),
    decisions: await db.all('SELECT * FROM decisions WHERE project_id=?', [projectId]),
    changes: await db.all('SELECT * FROM changes WHERE project_id=?', [projectId]),
    updates: await db.all('SELECT * FROM updates WHERE project_id=?', [projectId]),
    report: await projectReport(projectId)
  };
  const body = JSON.stringify(exportData, null, 2);
  textResponse(res, 200, body, 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="project-${projectId}-export.json"` });
});

function csvCell(value) {
  const string = String(value ?? '');
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

route('GET', '/api/projects/:projectId/tasks.csv', async ({ res, user, params }) => {
  const projectId = integer(params.projectId, 'project id');
  await projectWithAccess(user.id, projectId);
  const tasks = await db.all(`SELECT t.*,u.full_name owner_name FROM tasks t LEFT JOIN users u ON u.id=t.owner_id WHERE t.project_id=? ORDER BY t.id`, [projectId]);
  const headers = ['id','phase','title','owner_name','priority','status','progress','approved','due_date','acceptance_criteria'];
  const csv = [headers.join(','), ...tasks.map(task => headers.map(header => csvCell(task[header])).join(','))].join('\n');
  textResponse(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="project-${projectId}-tasks.csv"` });
});

function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const resolved = path.resolve(config.publicDir, `.${decoded}`);
  if (!resolved.startsWith(config.publicDir + path.sep) && resolved !== path.join(config.publicDir, 'index.html')) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const stat = fs.statSync(resolved);
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const extension = path.extname(resolved).toLowerCase();
  response.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  response.setHeader('Cache-Control', extension === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300');
  response.setHeader('ETag', etag);
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304);
    response.end();
    return true;
  }
  const content = fs.readFileSync(resolved);
  response.setHeader('Content-Length', content.length);
  response.writeHead(200);
  if (request.method === 'HEAD') response.end(); else response.end(content);
  return true;
}

function errorCode(status) {
  return ({
    400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE', 500: 'INTERNAL_ERROR'
  })[status] || 'REQUEST_FAILED';
}

async function handleRequest(request, response) {
  setCommonHeaders(request, response);
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Allow': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'GET,HEAD,POST,PATCH,DELETE,OPTIONS');
      throw new HttpError(405, 'Method not allowed');
    }

    const pathMatches = routes.filter(item => item.regex.test(url.pathname));
    const routeMatch = pathMatches.find(item => item.method === request.method);
    enforceRateLimit(request, response, routeMatch);

    if (!routeMatch) {
      if (!url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method) && serveStatic(request, response, url.pathname)) return;
      if (pathMatches.length) {
        response.setHeader('Allow', [...new Set(pathMatches.map(item => item.method))].join(','));
        throw new HttpError(405, 'Method not allowed');
      }
      throw new HttpError(404, 'Route not found');
    }

    validateRequestOrigin(request);
    const match = url.pathname.match(routeMatch.regex);
    const params = Object.fromEntries(routeMatch.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    const user = routeMatch.auth ? await requireUser(request) : null;
    const body = await parseBody(request);
    await routeMatch.handler({ req: request, res: response, url, query: url.searchParams, params, body, user });
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    const detail = error instanceof HttpError ? error.detail : 'Internal server error';
    if (!(error instanceof HttpError)) console.error(`[${request.requestId}]`, error);
    jsonResponse(response, status, {
      detail,
      code: errorCode(status),
      request_id: request.requestId
    });
  }
}

function createServer() {
  const server = http.createServer(handleRequest);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs + 5_000, 125_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  return server;
}

async function start() {
  await db.initDb();
  if (db.storageMode() === 'turso') {
    console.log('Turso connected: users, organizations, projects, tasks, chats, reports, settings, and auth data are persistent.');
  } else {
    console.warn('TURSO_DATABASE_URL/TURSO_AUTH_TOKEN are not set; using local SQLite for development. Render Free requires Turso for persistence.');
  }

  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`FlowMate v${packageJson.version} running at http://${config.host}:${config.port} (${config.nodeEnv})`);
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Closing FlowMate gracefully...`);
    closeRealtimeClients();
    const forceTimer = setTimeout(() => process.exit(1), 10_000);
    forceTimer.unref();
    server.close(async () => {
      try { await db.close(); } catch {}
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) {
  start().catch(error => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
}

module.exports = { createServer, start, HttpError };
