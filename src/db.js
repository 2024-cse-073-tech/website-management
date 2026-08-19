'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const useTurso = Boolean(config.turso.url && config.turso.authToken);
const transactionContext = new AsyncLocalStorage();
let localDatabase = null;
let remoteClient = null;

const SCHEMA_SQL = `

    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      workspace_type TEXT NOT NULL DEFAULT 'team' CHECK(workspace_type IN ('team','personal')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('ceo','admin','moderator','member')),
      department TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by INTEGER NOT NULL REFERENCES users(id),
      proposed_role TEXT NOT NULL DEFAULT 'member' CHECK(proposed_role IN ('admin','moderator','member')),
      proposed_department TEXT NOT NULL DEFAULT 'General',
      status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','awaiting_approval','approved','rejected','declined','cancelled')),
      user_responded_at TEXT,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_invitation
      ON invitations(organization_id, invited_user_id)
      WHERE status IN ('invited','awaiting_approval');

    CREATE TABLE IF NOT EXISTS workspace_invite_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      invited_by INTEGER NOT NULL REFERENCES users(id),
      identifier TEXT NOT NULL DEFAULT '',
      proposed_role TEXT NOT NULL DEFAULT 'member' CHECK(proposed_role IN ('admin','moderator','member')),
      proposed_department TEXT NOT NULL DEFAULT 'General',
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_by INTEGER REFERENCES users(id),
      used_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_invite_links_org
      ON workspace_invite_links(organization_id, expires_at);

    CREATE TABLE IF NOT EXISTS user_presence (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      presence_mode TEXT NOT NULL DEFAULT 'auto' CHECK(presence_mode IN ('auto','online','away','dnd','offline')),
      status_key TEXT NOT NULL DEFAULT 'free',
      status_label TEXT NOT NULL DEFAULT 'Free',
      status_emoji TEXT NOT NULL DEFAULT '🟢',
      custom_status TEXT NOT NULL DEFAULT '',
      status_expires_at TEXT,
      last_seen_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light','dark','system')),
      workspace_notifications INTEGER NOT NULL DEFAULT 1 CHECK(workspace_notifications IN (0,1)),
      mention_notifications INTEGER NOT NULL DEFAULT 1 CHECK(mention_notifications IN (0,1)),
      invitation_notifications INTEGER NOT NULL DEFAULT 1 CHECK(invitation_notifications IN (0,1)),
      activity_notifications INTEGER NOT NULL DEFAULT 1 CHECK(activity_notifications IN (0,1)),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      action_view TEXT NOT NULL DEFAULT '',
      read_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      activity_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      constraints TEXT NOT NULL DEFAULT '',
      assumptions TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      project_manager_id INTEGER REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );


    CREATE TABLE IF NOT EXISTS spaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '◫',
      color TEXT NOT NULL DEFAULT '#7b68ee',
      description TEXT NOT NULL DEFAULT '',
      is_private INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0,1)),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(space_id, name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS task_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '☷',
      color TEXT NOT NULL DEFAULT '#7b68ee',
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_lists_folder_name
      ON task_lists(folder_id, name COLLATE NOCASE)
      WHERE folder_id IS NOT NULL AND archived=0;

    CREATE INDEX IF NOT EXISTS idx_task_lists_space ON task_lists(space_id, archived, position);

    CREATE TABLE IF NOT EXISTS list_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      view_type TEXT NOT NULL CHECK(view_type IN ('list','board','calendar','dashboard')),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(list_id, user_id, name COLLATE NOCASE)
    );

    CREATE INDEX IF NOT EXISTS idx_list_views_user_list ON list_views(user_id, list_id, position, id);

    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      space_id INTEGER REFERENCES spaces(id) ON DELETE SET NULL,
      list_id INTEGER REFERENCES task_lists(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      record_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      list_id INTEGER REFERENCES task_lists(id) ON DELETE SET NULL,
      parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      phase TEXT NOT NULL DEFAULT 'General',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','done')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      start_date TEXT,
      due_date TEXT,
      estimate_minutes INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      source_type TEXT NOT NULL DEFAULT 'manual',
      ai_generated INTEGER NOT NULL DEFAULT 0,
      approved INTEGER NOT NULL DEFAULT 1,
      rejected INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS risks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      risk_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      ai_generated INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'approved',
      source TEXT NOT NULL DEFAULT 'manual',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      note TEXT NOT NULL,
      update_type TEXT NOT NULL DEFAULT 'progress',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      impact_scope TEXT NOT NULL DEFAULT '',
      impact_effort TEXT NOT NULL DEFAULT '',
      impact_dependencies TEXT NOT NULL DEFAULT '',
      impact_workload TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      suggestion_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES users(id),
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes(user_id, used_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id, status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_docs_org ON docs(organization_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
    CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON user_presence(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_user ON account_activity(user_id, created_at);

`;

function utcnow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeParams(params = []) {
  return params.map(value => value === undefined ? null : value);
}

function splitSqlStatements(script) {
  return String(script || '')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

function ensureLocalDatabase() {
  if (localDatabase) return localDatabase;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  localDatabase = new DatabaseSync(config.databasePath);
  localDatabase.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return localDatabase;
}

async function ensureRemoteClient() {
  if (remoteClient) return remoteClient;
  let createClient;
  try {
    ({ createClient } = await import('@libsql/client'));
  } catch (error) {
    throw new Error('Turso is configured but @libsql/client is not installed. Run npm install.');
  }
  remoteClient = createClient({
    url: config.turso.url,
    authToken: config.turso.authToken
  });
  return remoteClient;
}

function normalizeDbValue(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function rowsToObjects(result) {
  const columns = Array.from(result?.columns || []);
  return Array.from(result?.rows || []).map(row => {
    if (row && !Array.isArray(row) && typeof row === 'object') {
      const object = {};
      for (const column of columns) object[column] = normalizeDbValue(row[column]);
      return object;
    }
    return Object.fromEntries(columns.map((column, index) => [column, normalizeDbValue(row[index])]));
  });
}

async function all(sql, params = []) {
  const args = normalizeParams(params);
  if (!useTurso) return ensureLocalDatabase().prepare(sql).all(...args);
  const executor = transactionContext.getStore() || await ensureRemoteClient();
  const result = await executor.execute({ sql, args });
  return rowsToObjects(result);
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function run(sql, params = []) {
  const args = normalizeParams(params);
  if (!useTurso) {
    const result = ensureLocalDatabase().prepare(sql).run(...args);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  const executor = transactionContext.getStore() || await ensureRemoteClient();
  const result = await executor.execute({ sql, args });
  return {
    changes: Number(result.rowsAffected || 0),
    lastInsertRowid: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid)
  };
}

async function execScript(script) {
  const statements = splitSqlStatements(script);
  if (!useTurso) {
    ensureLocalDatabase().exec(script);
    return;
  }
  if (!statements.length) return;
  const client = await ensureRemoteClient();
  await client.batch(statements.map(sql => ({ sql, args: [] })), 'write');
}

async function initDb() {
  await execScript(SCHEMA_SQL);

  // Safe migrations for databases created by earlier iterations.
  const userColumns = new Set((await all('PRAGMA table_info(users)')).map(column => column.name));
  if (!userColumns.has('avatar_url')) await run("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");

  const organizationColumns = new Set((await all('PRAGMA table_info(organizations)')).map(column => column.name));
  if (!organizationColumns.has('workspace_type')) await run("ALTER TABLE organizations ADD COLUMN workspace_type TEXT NOT NULL DEFAULT 'team'");

  const membershipColumns = new Set((await all('PRAGMA table_info(memberships)')).map(column => column.name));
  if (!membershipColumns.has('department')) await run("ALTER TABLE memberships ADD COLUMN department TEXT NOT NULL DEFAULT 'General'");

  const invitationColumns = new Set((await all('PRAGMA table_info(invitations)')).map(column => column.name));
  if (!invitationColumns.has('proposed_department')) await run("ALTER TABLE invitations ADD COLUMN proposed_department TEXT NOT NULL DEFAULT 'General'");

  const presenceColumns = new Set((await all('PRAGMA table_info(user_presence)')).map(column => column.name));
  if (!presenceColumns.has('status_key')) await run("ALTER TABLE user_presence ADD COLUMN status_key TEXT NOT NULL DEFAULT 'free'");
  if (!presenceColumns.has('status_label')) await run("ALTER TABLE user_presence ADD COLUMN status_label TEXT NOT NULL DEFAULT 'Free'");
  if (!presenceColumns.has('status_emoji')) await run("ALTER TABLE user_presence ADD COLUMN status_emoji TEXT NOT NULL DEFAULT '🟢'");
  if (!presenceColumns.has('status_expires_at')) await run('ALTER TABLE user_presence ADD COLUMN status_expires_at TEXT');

  const projectColumns = new Set((await all('PRAGMA table_info(projects)')).map(column => column.name));
  if (!projectColumns.has('project_manager_id')) await run('ALTER TABLE projects ADD COLUMN project_manager_id INTEGER');
  await run(`UPDATE projects SET project_manager_id=(
    SELECT m.user_id FROM memberships m
    WHERE m.organization_id=projects.organization_id AND m.role='ceo' AND m.status='active'
    ORDER BY m.id LIMIT 1
  ) WHERE project_manager_id IS NULL`);

  const taskColumns = new Set((await all('PRAGMA table_info(tasks)')).map(column => column.name));
  if (!taskColumns.has('list_id')) await run('ALTER TABLE tasks ADD COLUMN list_id INTEGER');
  if (!taskColumns.has('parent_task_id')) await run('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER');
  if (!taskColumns.has('start_date')) await run('ALTER TABLE tasks ADD COLUMN start_date TEXT');
  if (!taskColumns.has('estimate_minutes')) await run('ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER NOT NULL DEFAULT 0');
  if (!taskColumns.has('sort_order')) await run('ALTER TABLE tasks ADD COLUMN sort_order REAL NOT NULL DEFAULT 0');
  if (!taskColumns.has('archived')) await run('ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
}

async function transaction(callback) {
  if (!useTurso) {
    const database = ensureLocalDatabase();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const client = await ensureRemoteClient();
  const tx = await client.transaction('write');
  try {
    const result = await transactionContext.run(tx, callback);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch {}
    throw error;
  } finally {
    try { await tx.close(); } catch {}
  }
}

async function log({ organizationId = null, projectId = null, actorUserId = null, entityType, entityId = null, action, details = '' }) {
  const serialized = typeof details === 'string' ? details : JSON.stringify(details);
  await run(
    'INSERT INTO audit_log(organization_id,project_id,actor_user_id,entity_type,entity_id,action,details,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [organizationId, projectId, actorUserId, entityType, entityId, action, serialized, utcnow()]
  );
}

async function healthCheck() {
  const row = await get('SELECT 1 AS ready');
  return Number(row?.ready || 0) === 1;
}

function storageMode() {
  return useTurso ? 'turso' : 'local-sqlite';
}

async function close() {
  if (remoteClient) {
    try { remoteClient.close(); } catch {}
    remoteClient = null;
  }
  if (localDatabase) {
    localDatabase.close();
    localDatabase = null;
  }
}

module.exports = { initDb, utcnow, all, get, run, transaction, log, healthCheck, storageMode, close };
