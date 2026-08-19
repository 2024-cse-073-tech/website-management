'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const STATUS = {
  not_started: { label: 'TO DO', short: 'To Do' },
  in_progress: { label: 'IN PROGRESS', short: 'In Progress' },
  blocked: { label: 'BLOCKED', short: 'Blocked' },
  done: { label: 'COMPLETE', short: 'Complete' }
};
const PRIORITY = { critical: 'Urgent', high: 'High', medium: 'Normal', low: 'Low' };
const WORK_STATUS = {
  free: { label:'Free', emoji:'🟢' },
  busy: { label:'Busy', emoji:'🔴' },
  on_work: { label:'On Work', emoji:'🔵' },
  work_from_home: { label:'Work From Home', emoji:'🏠' },
  on_leave: { label:'On Leave', emoji:'🏖️' },
  dnd: { label:'Do Not Disturb', emoji:'⛔' },
  in_meeting: { label:'In a Meeting', emoji:'🟡' },
  focus: { label:'Focus Time', emoji:'🎯' },
  travelling: { label:'Travelling', emoji:'✈️' },
  custom: { label:'Custom', emoji:'💬' }
};
const AI_UNAVAILABLE_WORK_STATUSES = new Set(['on_leave','dnd','travelling']);

const state = {
  me: null,
  presence: null,
  statusDraftKey: 'free',
  settings: null,
  organizations: [],
  pendingInvitations: [],
  inviteJoinError: '',
  aiStatus: null,
  aiProjectDraft: null,
  aiProjectMembers: [],
  aiProjectBrief: '',
  aiBriefFiles: [],
  org: null,
  tree: [],
  projects: [],
  members: [],
  channels: [],
  currentChannel: null,
  messages: [],
  docs: [],
  selectedDoc: null,
  currentList: null,
  activeSpaceId: null,
  customViews: [],
  activeCustomViewId: null,
  tasks: [],
  allTasks: [],
  globalView: 'home',
  listView: 'list',
  taskFilter: '',
  assigneeFilter: 'all',
  showClosed: true,
  calendarDate: new Date(),
  dashboard: null,
  selectedTaskId: null,
  taskTimerEntries: [],
  entityAction: null,
  entityContext: null,
  toastTimer: null,
  commandTimer: null,
  chatPoll: null,
  chatStream: null,
  chatStreamChannelId: null,
  manualBreakdownParent: null,
  manualBreakdownDraft: []
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] || '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}
function displayName(user) {
  return String(user?.full_name || user?.username || 'User').trim() || 'User';
}
function formatDate(value, options = {}) {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, options.compact ? { month:'short', day:'numeric' } : { month:'short', day:'numeric', year:'numeric' });
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}
function relativeTime(value) {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return '';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
function durationText(seconds) {
  let n = Math.max(0, Number(seconds || 0));
  const h = Math.floor(n / 3600); n -= h * 3600;
  const m = Math.floor(n / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(n)}s`;
}
function isOverdue(task) {
  return task.due_date && task.status !== 'done' && new Date(`${task.due_date}T23:59:59`).getTime() < Date.now();
}
function avatarMarkup(member, cls = 'mini-avatar') {
  const name = member?.owner_name || member?.full_name || member?.name || '';
  const url = member?.owner_avatar || member?.avatar_url || '';
  return `<span class="${cls}">${url ? `<img src="${escapeHtml(url)}" alt="">` : escapeHtml(initials(name))}</span>`;
}
function statusChip(status) { return `<span class="status-chip ${status}">${STATUS[status]?.label || escapeHtml(status)}</span>`; }
function priorityMarkup(priority) { return `<span class="priority ${priority}">${escapeHtml(PRIORITY[priority] || priority)}</span>`; }
function workStatusInfo(member = {}) {
  const key = member.status_key || 'free';
  const preset = WORK_STATUS[key] || WORK_STATUS.custom;
  return {
    key,
    label: member.status_label || preset.label,
    emoji: member.status_emoji || preset.emoji,
    note: member.custom_status || ''
  };
}
function workStatusMarkup(member = {}) {
  const info = workStatusInfo(member);
  return `<span class="person-work-status status-${escapeHtml(info.key)}" title="${escapeHtml(info.note || info.label)}"><span>${escapeHtml(info.emoji)}</span>${escapeHtml(info.label)}</span>`;
}
function updateStatusIndicators() {
  const info = workStatusInfo(state.presence || {});
  const dot = $('#topStatusDot');
  if (dot) {
    dot.className = `avatar-status-dot ${info.key}`;
    dot.title = `${info.emoji} ${info.label}${info.note ? ` — ${info.note}` : ''}`;
  }
}
function toast(message, type = '') {
  const el = $('#toast');
  clearTimeout(state.toastTimer);
  el.textContent = message;
  el.className = `toast ${type}`.trim();
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
function showOnly(screen) {
  ['loadingScreen','authScreen','onboardingScreen','workspaceShell'].forEach(id => $(`#${id}`).classList.toggle('hidden', id !== screen));
}
function setBusy(button, busy, label = 'Working…') {
  if (!button) return;
  if (busy) { button.dataset.oldText = button.textContent; button.textContent = label; button.disabled = true; }
  else { button.textContent = button.dataset.oldText || button.textContent; button.disabled = false; }
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try { response = await fetch(path, init); }
  catch { throw new Error('Network error. Check your connection and try again.'); }
  const text = await response.text();
  let payload = {};
  if (text) { try { payload = JSON.parse(text); } catch { payload = { detail: text }; } }
  if (!response.ok) {
    const error = new Error(payload.detail || payload.error || `Request failed (${response.status})`);
    error.status = response.status; error.payload = payload; throw error;
  }
  return payload;
}

function applyTheme(theme) {
  const preference = ['light','dark','system'].includes(theme) ? theme : 'light';
  const value = preference === 'dark' ? 'dark' : preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = value;
  const themeButton = $('#themeBtn');
  if (themeButton) themeButton.textContent = value === 'dark' ? '☀' : '☾';
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', value === 'dark' ? '#17171f' : '#f6f7fb');
  try { localStorage.setItem('flowmate-theme', preference); localStorage.removeItem('orbit_theme'); } catch {}
}

function inviteTokenFromValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, location.origin);
    return url.searchParams.get('invite') || raw;
  } catch { return raw; }
}
function currentInviteToken() {
  return new URLSearchParams(location.search).get('invite') || '';
}
function clearInviteTokenFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}
function updateInviteAuthHint() {
  const hint = $('#inviteAuthHint');
  if (!hint) return;
  hint.classList.toggle('hidden', !currentInviteToken());
}
async function applyMePayload(me) {
  state.me = me.user;
  state.presence = me.presence || state.presence;
  state.settings = me.settings;
  state.organizations = (me.organizations || []).filter(org => org.membership_status === 'active');
  applyTheme(state.settings?.theme || 'light');
  updateNotificationBadge(me.unread_notification_count || 0);
  updateStatusIndicators();
  return me;
}
async function renderOnboarding() {
  showOnly('onboardingScreen');
  $('#createWorkspacePanel').classList.add('hidden');
  $('#joinWorkspacePanel').classList.add('hidden');
  $('.onboarding-options').classList.remove('hidden');
  try { state.pendingInvitations = await api('/api/invitations/me'); }
  catch { state.pendingInvitations = []; }
  renderPendingInvitations();
  if (state.pendingInvitations.length || currentInviteToken() || state.inviteJoinError) showOnboardingPanel('join');
}
function showOnboardingPanel(type = '') {
  const options = $('.onboarding-options');
  const create = $('#createWorkspacePanel');
  const join = $('#joinWorkspacePanel');
  const active = type === 'create' || type === 'join';
  options.classList.toggle('hidden', active);
  create.classList.toggle('hidden', type !== 'create');
  join.classList.toggle('hidden', type !== 'join');
  if (type === 'join') {
    const token = currentInviteToken();
    if (token) $('#inviteTokenInput').value = `${location.origin}/?invite=${token}`;
  }
}
function renderPendingInvitations() {
  const mount = $('#pendingInvitations');
  if (!mount) return;
  const error = state.inviteJoinError ? `<div class="form-error">${escapeHtml(state.inviteJoinError)}</div>` : '';
  const cards = state.pendingInvitations.length ? state.pendingInvitations.map(invite => `
    <article class="pending-invite-card">
      <div><strong>${escapeHtml(invite.organization_name)}</strong><small>Invited by ${escapeHtml(invite.invited_by_name)} · ${escapeHtml(invite.proposed_role)} · ${escapeHtml(invite.proposed_department || 'General')}</small></div>
      <div class="pending-invite-actions"><button class="secondary-btn" data-decline-invite="${invite.id}">Decline</button><button class="primary-btn" data-accept-invite="${invite.id}">Join</button></div>
    </article>`).join('') : '<div class="onboarding-empty">No pending account invitations yet. You can still paste a workspace invite link below.</div>';
  mount.innerHTML = error + cards;
}

async function boot() {
  showOnly('loadingScreen');
  state.inviteJoinError = '';
  try {
    let me = await api('/api/auth/me');
    const inviteToken = currentInviteToken();
    if (inviteToken) {
      try {
        const joined = await api('/api/invitations/join', { method:'POST', body:{ token:inviteToken } });
        clearInviteTokenFromUrl();
        me = await api('/api/auth/me');
        setTimeout(() => toast(`Joined ${joined.organization?.name || 'workspace'}`), 80);
      } catch (error) {
        state.inviteJoinError = error.message;
      }
    }
    await applyMePayload(me);
    updateInviteAuthHint();
    if (!me.workspace_access?.can_access_workspace || !state.organizations.length) {
      await renderOnboarding();
      return;
    }
    const stored = Number(localStorage.getItem('flowmate-org-id'));
    const chosen = state.organizations.find(item => Number(item.id) === stored) || state.organizations[0];
    await selectOrganization(Number(chosen.id), false);
    showOnly('workspaceShell');
    setGlobalView('home');
    startHeartbeat();
    if (state.inviteJoinError) setTimeout(() => toast(state.inviteJoinError, 'error'), 80);
  } catch (error) {
    if (error.status === 401) {
      state.me = null;
      showOnly('authScreen');
      updateInviteAuthHint();
      return;
    }
    showOnly('authScreen');
    updateInviteAuthHint();
    showAuthError(error.message);
  }
}

function showAuthError(message) {
  const el = $('#authError');
  el.textContent = message;
  el.classList.remove('hidden');
}
function clearAuthError() { $('#authError').classList.add('hidden'); }
function setAuthMode(mode) {
  clearAuthError();
  $('#signInForm').classList.toggle('hidden', mode !== 'signin');
  $('#signUpForm').classList.toggle('hidden', mode !== 'signup');
  $('#resetForm').classList.toggle('hidden', mode !== 'reset');
  $('#signInTab').classList.toggle('active', mode === 'signin');
  $('#signUpTab').classList.toggle('active', mode === 'signup');
  $('.auth-tabs').classList.toggle('hidden', mode === 'reset');
  $('#authTitle').textContent = mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset password' : 'Welcome back';
  $('#authSubtitle').textContent = mode === 'signup' ? 'Start building your workspace' : mode === 'reset' ? 'Recover access to your account' : 'Sign in to your workspace';
  if (mode !== 'reset') {
    $('#resetCodeNotice').classList.add('hidden');
    $('#resetFields').classList.add('hidden');
    $('#resetCodeValue').textContent = '------';
    $('#resetCodeInput').value = '';
    const newPassword = $('#resetForm input[name="password"]');
    if (newPassword) newPassword.value = '';
  }
}

$('#signInTab').addEventListener('click', () => setAuthMode('signin'));
$('#signUpTab').addEventListener('click', () => setAuthMode('signup'));
$('#forgotBtn').addEventListener('click', () => setAuthMode('reset'));
$('#backToSignIn').addEventListener('click', () => setAuthMode('signin'));

$('#copyResetCodeBtn').addEventListener('click', async () => {
  const code = $('#resetCodeValue').textContent.trim();
  if (!/^\d{6}$/.test(code)) return;
  try {
    await navigator.clipboard.writeText(code);
    toast('Reset code copied.');
  } catch {
    $('#resetCodeInput').focus();
    $('#resetCodeInput').select();
    toast('Code selected. Press Ctrl+C to copy.');
  }
});

$('#signInForm').addEventListener('submit', async event => {
  event.preventDefault(); clearAuthError();
  const button = $('button[type="submit"]', event.currentTarget); setBusy(button, true, 'Signing in…');
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/auth/login', { method:'POST', body:data });
    await boot();
  } catch (error) { showAuthError(error.message); }
  finally { setBusy(button, false); }
});
$('#signUpForm').addEventListener('submit', async event => {
  event.preventDefault(); clearAuthError();
  const button = $('button[type="submit"]', event.currentTarget); setBusy(button, true, 'Creating…');
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/auth/register', { method:'POST', body:data });
    await boot();
  } catch (error) { showAuthError(error.message); }
  finally { setBusy(button, false); }
});
$('#sendResetBtn').addEventListener('click', async event => {
  clearAuthError();
  const email = $('#resetEmail').value.trim();
  if (!email || !$('#resetEmail').checkValidity()) {
    $('#resetEmail').reportValidity();
    return;
  }
  setBusy(event.currentTarget, true, 'Generating…');
  try {
    const result = await api('/api/auth/forgot-password', { method:'POST', body:{ email } });
    $('#resetFields').classList.remove('hidden');
    const code = String(result.dev_reset_code || '');
    if (/^\d{6}$/.test(code)) {
      $('#resetCodeValue').textContent = code;
      $('#resetCodeInput').value = code;
      $('#resetCodeNotice').classList.remove('hidden');
      toast('Reset code generated below.');
    } else {
      $('#resetCodeNotice').classList.add('hidden');
      $('#resetCodeValue').textContent = '------';
      $('#resetCodeInput').value = '';
      toast('If that account exists, a reset code has been sent.');
    }
  } catch (error) { showAuthError(error.message); }
  finally { setBusy(event.currentTarget, false); }
});
$('#resetForm').addEventListener('submit', async event => {
  event.preventDefault(); clearAuthError();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api('/api/auth/reset-password', { method:'POST', body:data });
    toast('Password updated. Sign in with your new password.'); setAuthMode('signin');
  } catch (error) { showAuthError(error.message); }
});

$('#workspaceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget); setBusy(button, true, 'Creating Workspace…');
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await api('/api/organizations', { method:'POST', body:data });
    await boot();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#chooseCreateWorkspace').addEventListener('click', () => showOnboardingPanel('create'));
$('#chooseJoinWorkspace').addEventListener('click', () => showOnboardingPanel('join'));
$$('[data-onboarding-back]').forEach(button => button.addEventListener('click', () => showOnboardingPanel('')));
$('#continuePersonalBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.classList.add('is-loading');
  try {
    await api('/api/personal-workspace', { method:'POST', body:{} });
    await boot();
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.classList.remove('is-loading'); }
});
$('#pendingInvitations').addEventListener('click', async event => {
  const accept = event.target.closest('[data-accept-invite]');
  const decline = event.target.closest('[data-decline-invite]');
  if (!accept && !decline) return;
  const invitationId = Number((accept || decline).dataset[accept ? 'acceptInvite' : 'declineInvite']);
  const button = accept || decline;
  setBusy(button, true, accept ? 'Joining…' : 'Declining…');
  try {
    await api(`/api/invitations/${invitationId}/${accept ? 'accept' : 'decline'}`, { method:'POST', body:{} });
    if (accept) return await boot();
    state.pendingInvitations = await api('/api/invitations/me');
    renderPendingInvitations();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
$('#joinByTokenBtn').addEventListener('click', async event => {
  const token = inviteTokenFromValue($('#inviteTokenInput').value);
  if (!token) return toast('Paste an invitation link or token first.', 'error');
  setBusy(event.currentTarget, true, 'Joining…');
  try {
    const joined = await api('/api/invitations/join', { method:'POST', body:{ token } });
    clearInviteTokenFromUrl();
    toast(`Joined ${joined.organization?.name || 'workspace'}`);
    await boot();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(event.currentTarget, false); }
});
$('#onboardingLogout').addEventListener('click', logout);

async function logout() {
  try { await api('/api/auth/logout', { method:'POST', body:{} }); } catch {}
  state.me = null; state.org = null; state.tree = []; state.tasks = [];
  stopChatRealtime(); showOnly('authScreen'); setAuthMode('signin');
}

async function selectOrganization(id, render = true) {
  const org = state.organizations.find(item => Number(item.id) === Number(id));
  if (!org) return;
  state.org = org;
  localStorage.setItem('flowmate-org-id', String(id));
  const [tree, projects, members, channels, docs] = await Promise.all([
    api(`/api/organizations/${id}/workspace-tree`),
    api(`/api/organizations/${id}/projects`),
    api(`/api/organizations/${id}/members`),
    api(`/api/organizations/${id}/channels`),
    api(`/api/organizations/${id}/docs`)
  ]);
  state.tree = tree || [];
  state.projects = projects || [];
  state.members = members || [];
  const selfMember = state.members.find(member => Number(member.user_id) === Number(state.me?.id));
  if (selfMember) state.presence = { ...(state.presence || {}), ...selfMember };
  state.channels = channels || [];
  state.docs = docs || [];
  state.currentChannel = state.channels.find(ch => Number(ch.id) === Number(state.currentChannel?.id)) || state.channels[0] || null;
  const lists = flattenLists();
  const savedListId = Number(localStorage.getItem(`flowmate-list-${id}`));
  state.currentList = lists.find(list => Number(list.id) === savedListId) || lists[0] || null;
  renderSidebar();
  updateShellIdentity();
  if (render) setGlobalView('home');
}

function flattenLists() {
  const lists = [];
  for (const space of state.tree) {
    for (const list of space.lists || []) lists.push({ ...list, space_name:space.name, space_id:space.id, folder_name:'' });
    for (const folder of space.folders || []) {
      for (const list of folder.lists || []) lists.push({ ...list, space_name:space.name, space_id:space.id, folder_name:folder.name, folder_id:folder.id });
    }
  }
  return lists;
}
function findList(id) { return flattenLists().find(list => Number(list.id) === Number(id)) || null; }
function findSpace(id) { return state.tree.find(space => Number(space.id) === Number(id)) || null; }
function findFolder(id) {
  for (const space of state.tree) {
    const folder = (space.folders || []).find(item => Number(item.id) === Number(id));
    if (folder) return { ...folder, space_id:space.id, space_name:space.name };
  }
  return null;
}
function updateShellIdentity() {
  const personal = state.org?.workspace_type === 'personal';
  $('#workspaceName').textContent = personal ? 'Personal' : (state.org?.name || 'Workspace');
  $('#workspaceRole').textContent = personal ? 'Just you' : (state.org?.role || 'member');
  $('#workspaceInitial').textContent = personal ? initials(state.me?.full_name || 'P').slice(0,1) : initials(state.org?.name || 'W').slice(0,1);
  $('#newSpaceBtn')?.classList.toggle('hidden', state.org?.role !== 'ceo');
  const topAvatar = $('#topAvatar');
  const fallbackInitials = initials(state.me?.full_name || state.me?.username);
  const avatarUrl = state.me?.avatar_url || '';
  topAvatar.replaceChildren();
  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = `${state.me?.full_name || state.me?.username || 'User'} profile photo`;
    img.addEventListener('error', () => { topAvatar.textContent = fallbackInitials; });
    topAvatar.appendChild(img);
  } else {
    topAvatar.textContent = fallbackInitials;
  }
  updateStatusIndicators();
}
function updateNotificationBadge(count) {
  const badge = $('#topInboxBadge');
  badge.textContent = Number(count) > 99 ? '99+' : String(count || 0);
  badge.classList.toggle('hidden', !Number(count));
}

function visibleProjects() {
  return (state.projects || []).filter(project => !(project.name === 'Project Management' && Number(project.task_count || 0) === 0));
}

function renderProjectsSidebar() {
  const mount = $('#projectsTree');
  if (mount) mount.innerHTML = '';
  const count = $('#projectsOverviewCount');
  if (count) count.textContent = String(visibleProjects().length);
}

function renderSidebar() {
  renderProjectsSidebar();
  const mount = $('#spacesTree');
  mount.innerHTML = state.tree.map(space => {
    const projectCount = visibleProjects().filter(project => Number(project.space_id) === Number(space.id)).length;
    const active = state.globalView === 'space' && Number(state.activeSpaceId) === Number(space.id) ? 'active' : '';
    return `<div class="tree-space">
      <div class="tree-row ${active}" data-space="${space.id}"><span class="caret"></span><span class="tree-icon">${escapeHtml(space.icon || '◫')}</span><span class="tree-name">${escapeHtml(space.name)}</span><span class="task-count">${projectCount || ''}</span><button class="row-action" data-tree-menu="space" data-id="${space.id}">•••</button></div>
    </div>`;
  }).join('') || `<div class="sidebar-empty-copy">No Spaces yet. ${state.org?.role === 'ceo' ? 'Create your first Space.' : ''}</div>`;
  const newSpaceButton = $('#newSpaceBtn');
  if (newSpaceButton) newSpaceButton.classList.toggle('hidden', state.org?.role !== 'ceo');
  updateSidebarSelection();
}
function renderTreeList(list) {
  const active = Number(state.currentList?.id) === Number(list.id) && state.globalView === 'list' ? 'active' : '';
  return `<div class="tree-list"><div class="tree-row ${active}" data-list="${list.id}"><span class="caret"></span><span class="tree-icon">▤</span><span class="tree-name">${escapeHtml(list.name)}</span><span class="task-count">${Number(list.task_count || 0) || ''}</span><button class="row-action" data-tree-menu="list" data-id="${list.id}">•••</button></div></div>`;
}
function updateSidebarSelection() {
  $$('.sidebar-link').forEach(btn => btn.classList.remove('active'));
  $$('.tree-row[data-space]').forEach(row => row.classList.toggle('active', state.globalView === 'space' && Number(row.dataset.space) === Number(state.activeSpaceId)));
  $('#projectsOverviewBtn')?.classList.toggle('active', state.globalView === 'projects');
  if (state.globalView === 'all') $('[data-special="all"]')?.classList.add('active');
  if (state.globalView === 'me') $('[data-special="me"]')?.classList.add('active');
}

$('#spacesTree').addEventListener('click', event => {
  const menu = event.target.closest('[data-tree-menu]');
  if (menu) { event.stopPropagation(); openTreeMenu(menu.dataset.treeMenu, Number(menu.dataset.id), menu); return; }
  const space = event.target.closest('[data-space]');
  if (space) renderSpaceOverview(Number(space.dataset.space));
});
$('#projectsOverviewBtn')?.addEventListener('click', () => renderProjectsOverview());
$('#newAiProjectSidebarBtn')?.addEventListener('click', () => {
  if (!state.tree.length) {
    if (state.org?.role === 'ceo') openEntityDialog('space');
    else toast('A CEO must create a Space before projects can be created.', 'error');
    return;
  }
  openAiProjectPlanner('');
});
$$('[data-special]').forEach(button => button.addEventListener('click', () => renderAllTasks(button.dataset.special)));

async function openList(listId) {
  closeMobileSidebar();
  const list = findList(listId);
  if (!list) return;
  state.currentList = list; state.globalView = 'list'; state.activeSpaceId = Number(list.space_id) || null;
  localStorage.setItem(`flowmate-list-${state.org.id}`, String(list.id));
  setActiveRail(null); updateSidebarSelection();
  await loadListTasks();
  const saved = localStorage.getItem(`flowmate-list-view-${list.id}`) || 'list';
  if (saved.startsWith('custom:')) {
    const viewId = Number(saved.slice(7));
    const custom = state.customViews.find(view => Number(view.id) === viewId);
    if (custom) { state.activeCustomViewId = viewId; state.listView = custom.view_type; }
    else { state.activeCustomViewId = null; state.listView = 'list'; }
  } else {
    state.activeCustomViewId = null;
    state.listView = ['list','board','calendar','dashboard'].includes(saved) ? saved : 'list';
  }
  renderListShell();
}
async function loadListTasks() {
  if (!state.currentList) { state.tasks = []; state.customViews = []; return; }
  const [tasks, views] = await Promise.all([
    api(`/api/lists/${state.currentList.id}/tasks`),
    api(`/api/lists/${state.currentList.id}/views`)
  ]);
  state.tasks = tasks || [];
  state.customViews = views || [];
}
function activateListView(viewType, customViewId = null) {
  state.listView = ['list','board','calendar','dashboard'].includes(viewType) ? viewType : 'list';
  state.activeCustomViewId = customViewId ? Number(customViewId) : null;
  if (state.currentList) localStorage.setItem(`flowmate-list-view-${state.currentList.id}`, state.activeCustomViewId ? `custom:${state.activeCustomViewId}` : state.listView);
  renderListShell();
}

function setActiveRail(view) {
  $$('.rail-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.global === view));
}
$$('.rail-btn').forEach(button => button.addEventListener('click', () => setGlobalView(button.dataset.global)));
$('#topInboxBtn').addEventListener('click', () => setGlobalView('inbox'));

async function setGlobalView(view) {
  state.globalView = view; state.activeSpaceId = null; setActiveRail(view); updateSidebarSelection(); stopChatRealtime();
  try {
    if (view === 'home') await renderHome();
    else if (view === 'inbox') await renderInbox();
    else if (view === 'chat') await renderChat();
    else if (view === 'docs') await renderDocs();
    else if (view === 'dashboard') await renderWorkspaceDashboard();
    else if (view === 'people') renderPeople();
    else if (view === 'settings') renderSettings();
  } catch (error) { toast(error.message, 'error'); }
}

async function renderHome() {
  const [myTasks, dashboard] = await Promise.all([
    api(`/api/organizations/${state.org.id}/tasks?scope=me`),
    api(`/api/organizations/${state.org.id}/workspace-dashboard`)
  ]);
  state.dashboard = dashboard;
  const due = myTasks.filter(task => task.status !== 'done').slice(0, 8);
  const overdue = myTasks.filter(isOverdue).length;
  const inProgress = myTasks.filter(task => task.status === 'in_progress').length;
  $('#contentMount').innerHTML = `<div class="home-page">
    <div class="home-hero"><div><h1>Good ${dayPart()}, ${escapeHtml(displayName(state.me))}</h1><p>Here’s what needs your attention in ${escapeHtml(state.org.name)}.</p></div><div class="home-hero-actions"><button class="secondary-btn ai-plan-hero-btn" data-action="ai-project-planner">✦ Plan project with AI</button><button class="primary-btn" data-action="new-task">＋ Add task</button></div></div>
    <div class="home-cards">
      <div class="home-card" data-home-filter="me"><small>Assigned to me</small><strong>${myTasks.filter(t=>t.status!=='done').length}</strong></div>
      <div class="home-card"><small>In progress</small><strong>${inProgress}</strong></div>
      <div class="home-card"><small>Overdue</small><strong>${overdue}</strong></div>
    </div>
    <div class="dash-card"><h3>My work</h3>${due.length ? renderAllTaskTable(due) : `<div class="empty-state" style="min-height:220px"><div><div class="empty-icon">✓</div><h3>You’re all caught up</h3><p>Create or assign a task to see it here.</p></div></div>`}</div>
  </div>`;
}
function dayPart() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }

async function renderAllTasks(scope = 'all') {
  closeMobileSidebar();
  state.globalView = scope; setActiveRail('home'); updateSidebarSelection();
  const tasks = await api(`/api/organizations/${state.org.id}/tasks?scope=${scope}`);
  state.allTasks = tasks;
  const hierarchyStats = taskHierarchyStats(tasks);
  $('#contentMount').innerHTML = `<div class="simple-page">
    <div class="simple-page-header"><div><h2>${scope === 'me' ? 'My Tasks' : 'All Tasks'}</h2><p class="all-task-summary">${scope === 'me' ? 'Every task assigned to you across all projects.' : 'Every Main Task, Subtask and nested Step across all workspace projects.'}</p></div><div class="page-actions"><button class="primary-btn" data-action="new-task">＋ Add task</button></div></div>
    <div class="simple-page-body"><div class="toolbar all-task-toolbar" style="position:static;margin:-18px -18px 14px"><div class="inline-search"><span>⌕</span><input id="allTaskSearch" placeholder="Search task, project, assignee…"></div><div class="toolbar-spacer"></div><div class="all-task-counts"><b>${tasks.length}</b> total <span>•</span> ${hierarchyStats.main} main <span>•</span> ${hierarchyStats.subtask} sub <span>•</span> ${hierarchyStats.nested} nested</div></div>
    <div id="allTaskTableMount">${renderAllTaskTable(tasks, { groupByProject: scope === 'all' })}</div></div>
  </div>`;
  $('#allTaskSearch')?.addEventListener('input', event => {
    const q = event.target.value.trim().toLowerCase();
    const filtered = tasks.filter(task => !q || `${task.title} ${task.description || ''} ${task.project_name || ''} ${task.list_name || ''} ${task.space_name || ''} ${task.owner_name || ''} ${task.parent_title || ''}`.toLowerCase().includes(q));
    $('#allTaskTableMount').innerHTML = renderAllTaskTable(filtered, { groupByProject: scope === 'all' });
  });
}
function taskHierarchyStats(tasks) {
  return tasks.reduce((stats, task) => {
    const depth = Math.max(0, Number(task.task_depth || 0));
    if (depth === 0) stats.main += 1;
    else if (depth === 1) stats.subtask += 1;
    else stats.nested += 1;
    return stats;
  }, { main: 0, subtask: 0, nested: 0 });
}
function renderAllTaskRow(task) {
  const depth = Math.max(0, Number(task.task_depth || 0));
  const levelLabel = depth === 0 ? 'MAIN' : depth === 1 ? 'SUB' : 'STEP';
  const branch = depth ? '<span class="all-task-branch">↳</span>' : '';
  const location = [task.project_name, task.space_name, task.list_name].filter(Boolean).join(' / ') || 'Workspace';
  return `<div class="all-task-row task-depth-${Math.min(depth, 3)}" data-task-level="${escapeHtml(task.task_level || levelLabel.toLowerCase())}"><div class="all-task-name-cell" style="--task-depth:${Math.min(depth, 6)}">${branch}<span class="all-task-level-badge ${depth===0?'main':depth===1?'sub':'step'}">${levelLabel}</span><button class="all-task-title" data-open-task="${task.id}" data-list-id="${task.list_id || ''}">${escapeHtml(task.title)}</button></div><div class="location-path">${escapeHtml(location)}</div><div class="all-task-assignee">${task.owner_name ? `${avatarMarkup(task)} ${escapeHtml(task.owner_name)}` : '<span class="muted-dash">Unassigned</span>'}</div><div class="${isOverdue(task)?'due-overdue':''}">${task.due_date ? formatDate(task.due_date,{compact:true}) : '—'}</div><div>${priorityMarkup(task.priority)}</div></div>`;
}
function renderAllTaskTable(tasks, options = {}) {
  if (!tasks.length) return `<div class="empty-state"><div><div class="empty-icon">☷</div><h3>No tasks here</h3><p>Add a task or change your filters.</p></div></div>`;
  const table = rows => `<div class="all-task-table"><div class="all-task-row header"><div>Name</div><div>Location</div><div>Assignee</div><div>Due date</div><div>Priority</div></div>${rows.map(renderAllTaskRow).join('')}</div>`;
  if (!options.groupByProject) return table(tasks);
  const groups = [];
  const byProject = new Map();
  for (const task of tasks) {
    const key = String(task.project_id || 'workspace');
    if (!byProject.has(key)) {
      const group = { projectName: task.project_name || task.list_name || 'Workspace', tasks: [] };
      byProject.set(key, group); groups.push(group);
    }
    byProject.get(key).tasks.push(task);
  }
  return `<div class="all-task-projects">${groups.map(group => {
    const stats = taskHierarchyStats(group.tasks);
    return `<section class="all-task-project-group"><div class="all-task-project-head"><div><strong>${escapeHtml(group.projectName)}</strong><small>${group.tasks.length} tasks · ${stats.main} main · ${stats.subtask} sub · ${stats.nested} nested</small></div></div>${table(group.tasks)}</section>`;
  }).join('')}</div>`;
}

function projectCardMarkup(project) {
  const location = [project.space_name, project.folder_name].filter(Boolean).join(' / ') || 'No Space';
  const canOpen = Number(project.list_id) > 0;
  return `<button class="project-overview-card ${canOpen ? '' : 'disabled'}" ${canOpen ? `data-open-project="${project.id}" data-list-id="${project.list_id}"` : 'disabled'}>
    <span class="project-card-top"><span class="project-card-icon">${escapeHtml(project.list_icon || '✦')}</span><span class="project-card-location">${escapeHtml(location)}</span></span>
    <strong>${escapeHtml(project.name)}</strong>
    <span class="project-card-meta"><b>${Number(project.task_count || 0)}</b> tasks${project.project_manager_name ? ` · ${escapeHtml(project.project_manager_name)}` : ''}</span>
    <span class="project-card-open">Open project <b>›</b></span>
  </button>`;
}

function closeMobileSidebar() {
  $('#spacesSidebar')?.classList.remove('mobile-open');
  $('#mobileBackdrop')?.classList.add('hidden');
}

function renderProjectsOverview() {
  closeMobileSidebar();
  state.globalView = 'projects'; state.activeSpaceId = null; setActiveRail(null); updateSidebarSelection();
  const projects = visibleProjects();
  const canCreateSpace = state.org?.role === 'ceo';
  $('#contentMount').innerHTML = `<div class="simple-page projects-overview-page">
    <div class="simple-page-header"><div><h2>Projects</h2><p class="all-task-summary">All workspace projects are here. Open a project to see only that project's tasks and subtasks.</p></div><div class="page-actions">${!state.tree.length && canCreateSpace ? '<button class="secondary-btn" data-action="create-space">＋ Create Space</button>' : ''}<button class="primary-btn" data-action="ai-project-planner" ${!state.tree.length ? 'disabled' : ''}>✦ New project</button></div></div>
    <div class="simple-page-body">${projects.length ? `<div class="project-overview-grid">${projects.map(projectCardMarkup).join('')}</div>` : `<div class="empty-state project-empty-state"><div><div class="empty-icon">✦</div><h3>No projects yet</h3><p>${state.tree.length ? 'Create your first project. It will appear here, not as a long sidebar list.' : (canCreateSpace ? 'Create a Space first, then create projects inside it.' : 'A CEO needs to create the first Space before projects can be added.')}</p>${!state.tree.length && canCreateSpace ? '<button class="primary-btn" data-action="create-space">Create first Space</button>' : state.tree.length ? '<button class="primary-btn" data-action="ai-project-planner">Create project</button>' : ''}</div></div>`}</div>
  </div>`;
}

async function renderSpaceOverview(spaceId) {
  closeMobileSidebar();
  const space = findSpace(spaceId);
  if (!space) return;
  state.globalView = 'space'; state.activeSpaceId = Number(spaceId); setActiveRail(null); updateSidebarSelection();
  const projects = visibleProjects().filter(project => Number(project.space_id) === Number(spaceId));
  let tasks = [];
  try {
    const all = await api(`/api/organizations/${state.org.id}/tasks?scope=all`);
    tasks = all.filter(task => Number(task.space_id) === Number(spaceId));
  } catch (error) { toast(error.message, 'error'); }
  $('#contentMount').innerHTML = `<div class="simple-page space-overview-page">
    <div class="simple-page-header"><div><div class="space-page-kicker">${escapeHtml(space.icon || '◫')} SPACE</div><h2>${escapeHtml(space.name)}</h2><p class="all-task-summary">${escapeHtml(space.description || 'Projects and tasks inside this Space.')}</p></div><div class="page-actions"><button class="primary-btn" data-action="ai-project-planner">✦ New project</button></div></div>
    <div class="simple-page-body"><section class="space-project-section"><div class="space-section-title"><div><h3>Projects</h3><span>${projects.length} project${projects.length === 1 ? '' : 's'}</span></div></div>${projects.length ? `<div class="project-overview-grid">${projects.map(projectCardMarkup).join('')}</div>` : `<div class="empty-state project-empty-state"><div><div class="empty-icon">✦</div><h3>No projects in this Space</h3><p>Create a project and it will stay grouped inside ${escapeHtml(space.name)}.</p><button class="primary-btn" data-action="ai-project-planner">Create project</button></div></div>`}</section>
    <section class="space-task-section"><div class="space-section-title"><div><h3>Tasks by project</h3><span>${tasks.length} total task${tasks.length === 1 ? '' : 's'}</span></div></div>${tasks.length ? renderAllTaskTable(tasks, { groupByProject:true }) : '<div class="empty-state compact-empty"><div><div class="empty-icon">✓</div><h3>No tasks yet</h3><p>Tasks will appear here grouped by their project.</p></div></div>'}</section></div>
  </div>`;
}

function renderListShell() {
  const list = state.currentList;
  if (!list) { $('#contentMount').innerHTML = `<div class="empty-state"><div><div class="empty-icon">＋</div><h3>Create a List</h3><p>Lists contain tasks and can live directly in a Space or inside a Folder.</p><button class="primary-btn" data-action="new-list">Create List</button></div></div>`; return; }
  $('#contentMount').innerHTML = `<section class="list-page">
    <header class="content-header">
      <div class="title-row"><div><div class="breadcrumb"><span>${escapeHtml(list.space_name)}</span>${list.folder_name ? `<span>›</span><span>${escapeHtml(list.folder_name)}</span>` : ''}</div><h1 class="content-title"><span class="title-icon">▤</span>${escapeHtml(list.name)}</h1></div><div class="title-spacer"></div><div class="header-actions"><button class="header-action" data-action="ai-list-plan">✦ AI plan</button><button class="header-action" data-action="share-list">Share</button><button class="header-action" data-action="list-menu">•••</button></div></div>
      <nav class="view-tabs">${['list','board','calendar','dashboard'].map(view => `<button class="view-tab ${!state.activeCustomViewId&&state.listView===view?'active':''}" data-list-view="${view}">${view === 'list' ? '☷ List' : view === 'board' ? '▥ Board' : view === 'calendar' ? '▦ Calendar' : '▦ Dashboard'}</button>`).join('')}${state.customViews.map(view => `<span class="custom-view-wrap ${Number(state.activeCustomViewId)===Number(view.id)?'active':''}"><button class="view-tab custom-view ${Number(state.activeCustomViewId)===Number(view.id)?'active':''}" data-custom-view="${view.id}">${view.view_type==='list'?'☷':view.view_type==='board'?'▥':view.view_type==='calendar'?'▦':'▦'} ${escapeHtml(view.name)}</button><button class="custom-view-delete" data-delete-custom-view="${view.id}" title="Delete view">×</button></span>`).join('')}<button class="view-tab add-view" data-action="add-view">＋ View</button></nav>
    </header>
    <div id="listViewMount" class="view-body"></div>
  </section>`;
  renderCurrentListView();
}
function renderCurrentListView() {
  const mount = $('#listViewMount'); if (!mount) return;
  if (state.listView === 'list') renderListView(mount);
  else if (state.listView === 'board') renderBoardView(mount);
  else if (state.listView === 'calendar') renderCalendarView(mount);
  else renderListDashboard(mount);
}
function filteredTasks() {
  const q = state.taskFilter.toLowerCase();
  return state.tasks.filter(task => {
    if (!state.showClosed && task.status === 'done') return false;
    if (state.assigneeFilter !== 'all' && String(task.owner_id || 'unassigned') !== state.assigneeFilter) return false;
    return !q || `${task.title} ${task.description || ''} ${task.owner_name || ''}`.toLowerCase().includes(q);
  });
}
function renderToolbar() {
  return `<div class="toolbar"><button class="tool-btn">◫ Group: Status</button><button class="tool-btn">⌘ Subtasks</button><button class="tool-btn">▥ Columns</button><button class="tool-btn" data-action="toggle-closed">${state.showClosed ? '◉' : '○'} Closed</button><select id="assigneeFilter"><option value="all">Assignee</option><option value="unassigned" ${state.assigneeFilter==='unassigned'?'selected':''}>Unassigned</option>${state.members.filter(m=>m.status==='active').map(m=>`<option value="${m.user_id}" ${state.assigneeFilter===String(m.user_id)?'selected':''}>${escapeHtml(m.full_name)}</option>`).join('')}</select><div class="toolbar-spacer"></div><div class="inline-search"><span>⌕</span><input id="taskSearch" value="${escapeHtml(state.taskFilter)}" placeholder="Search…"></div><button class="add-task-btn" data-action="new-task">＋ Add Task</button></div>`;
}
function renderListView(mount) {
  const tasks = filteredTasks();
  const groups = Object.keys(STATUS);
  mount.innerHTML = renderToolbar() + `<div class="task-list-wrap">${groups.map(status => {
    const items = tasks.filter(task => task.status === status);
    if (!state.showClosed && status === 'done') return '';
    return `<section class="task-group" data-status-group="${status}">
      <div class="group-header"><button class="group-toggle">⌄</button><span class="status-chip ${status}">${STATUS[status].label}</span><span class="group-count">${items.length}</span><button class="group-add" data-add-task-status="${status}">＋ Add Task</button></div>
      <div class="list-grid-header"><div>Name</div><div>Assignee</div><div>Due date</div><div>Priority</div><div>Status</div><div></div></div>
      ${items.map(renderTaskRow).join('')}
      <div class="add-task-row"><button data-add-task-status="${status}">＋ Add Task</button></div>
    </section>`;
  }).join('')}</div>`;
  bindListToolbar();
}
function taskHierarchyDepth(task) {
  let depth = 0;
  let parentId = Number(task.parent_task_id || 0);
  const byId = new Map(state.tasks.map(item => [Number(item.id), item]));
  const seen = new Set();
  while (parentId && depth < 6 && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = Number(byId.get(parentId)?.parent_task_id || 0);
  }
  return depth;
}
function renderTaskRow(task) {
  const depth = taskHierarchyDepth(task);
  const isSubtask = depth > 0;
  const branch = depth > 1 ? '↳↳' : '↳';
  return `<div class="task-row ${isSubtask?'subtask-row':''} task-depth-${depth}" style="--task-depth:${depth}" data-task-row="${task.id}" data-parent-task="${task.parent_task_id||''}">
    <div class="task-cell task-name-cell">${isSubtask?`<span class="subtask-branch">${branch}</span>`:''}<button class="task-checkbox ${task.status==='done'?'done':''}" data-toggle-task="${task.id}">${task.status==='done'?'✓':''}</button><button class="task-title-btn" data-open-task="${task.id}">${escapeHtml(task.title)}</button>${task.source_type==='ai_project_plan'&&!task.parent_task_id?'<span class="main-task-badge">MAIN</span>':''}${depth>1?'<span class="nested-task-badge">STEP</span>':''}${task.comment_count ? `<span style="font-size:9px;color:var(--muted)">◌ ${task.comment_count}</span>`:''}</div>
    <div class="task-cell assignee-cell">${task.owner_name ? `${avatarMarkup(task)}<span>${escapeHtml(task.owner_name)}</span>` : '<span class="muted-dash">＋</span>'}</div>
    <div class="task-cell ${isOverdue(task)?'due-overdue':''}">${task.due_date ? formatDate(task.due_date,{compact:true}) : '<span class="muted-dash">—</span>'}</div>
    <div class="task-cell">${priorityMarkup(task.priority)}</div>
    <div class="task-cell">${statusChip(task.status)}</div>
    <div class="task-cell task-row-actions"><button class="row-menu-btn" data-task-menu="${task.id}">•••</button></div>
  </div>`;
}
function bindListToolbar() {
  $('#taskSearch')?.addEventListener('input', event => { state.taskFilter = event.target.value; renderCurrentListView(); });
  $('#assigneeFilter')?.addEventListener('change', event => { state.assigneeFilter = event.target.value; renderCurrentListView(); });
}

function renderBoardView(mount) {
  const tasks = filteredTasks();
  const byStatus = Object.fromEntries(Object.keys(STATUS).map(status => [status, []]));
  for (const task of tasks) if (byStatus[task.status]) byStatus[task.status].push(task);
  mount.innerHTML = renderToolbar() + `<div class="board-wrap">${Object.keys(STATUS).map(status => {
    const items = byStatus[status];
    return `<section class="board-column" data-drop-status="${status}"><div class="board-column-header">${statusChip(status)}<span class="board-column-count">${items.length}</span><button data-add-task-status="${status}">＋</button></div><div class="board-cards">${items.map(task => `<article class="board-card" draggable="true" data-drag-task="${task.id}" data-open-task="${task.id}"><h4>${escapeHtml(task.title)}</h4><div class="board-card-meta">${task.owner_name ? avatarMarkup(task) : '<span class="mini-avatar">?</span>'}<span>${task.due_date ? formatDate(task.due_date,{compact:true}) : 'No due date'}</span>${priorityMarkup(task.priority)}</div></article>`).join('')}</div><button class="board-add" data-add-task-status="${status}">＋ Add Task</button></section>`;
  }).join('')}</div>`;
  bindListToolbar(); bindBoardDnD();
}
function bindBoardDnD() {
  const board = $('.board-wrap');
  if (!board) return;
  let draggedCard = null;
  let highlightedColumn = null;
  let highlightFrame = 0;
  let dragImage = null;

  const clearHighlight = () => {
    if (highlightFrame) cancelAnimationFrame(highlightFrame);
    highlightFrame = 0;
    if (highlightedColumn) highlightedColumn.classList.remove('dragover');
    highlightedColumn = null;
  };
  const scheduleHighlight = column => {
    if (column === highlightedColumn) return;
    if (highlightFrame) cancelAnimationFrame(highlightFrame);
    highlightFrame = requestAnimationFrame(() => {
      if (highlightedColumn) highlightedColumn.classList.remove('dragover');
      highlightedColumn = column || null;
      if (highlightedColumn) highlightedColumn.classList.add('dragover');
      highlightFrame = 0;
    });
  };
  const updateColumnCount = column => {
    const count = column?.querySelector('.board-column-count');
    const cards = column?.querySelector('.board-cards');
    if (count && cards) count.textContent = String(cards.children.length);
  };
  const cleanupDrag = () => {
    clearHighlight();
    board.classList.remove('is-dragging');
    if (draggedCard) draggedCard.classList.remove('is-dragging');
    draggedCard = null;
    if (dragImage) dragImage.remove();
    dragImage = null;
  };

  board.addEventListener('dragstart', event => {
    const card = event.target.closest('[data-drag-task]');
    if (!card || card.classList.contains('is-saving')) return;
    draggedCard = card;
    board.classList.add('is-dragging');
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/task-id', card.dataset.dragTask);

    // A lightweight drag preview avoids repainting the full task card tree while moving.
    dragImage = document.createElement('div');
    dragImage.className = 'board-drag-image';
    dragImage.textContent = card.querySelector('h4')?.textContent || 'Task';
    dragImage.style.width = `${Math.min(Math.max(card.getBoundingClientRect().width, 180), 300)}px`;
    document.body.appendChild(dragImage);
    event.dataTransfer.setDragImage(dragImage, 24, 18);
  });

  board.addEventListener('dragover', event => {
    if (!draggedCard) return;
    const column = event.target.closest('[data-drop-status]');
    if (!column || !board.contains(column)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    scheduleHighlight(column);
  }, { passive:false });

  board.addEventListener('drop', async event => {
    if (!draggedCard) return;
    const column = event.target.closest('[data-drop-status]');
    if (!column || !board.contains(column)) return;
    event.preventDefault();
    const taskId = Number(event.dataTransfer.getData('text/task-id') || draggedCard.dataset.dragTask);
    if (!taskId) { cleanupDrag(); return; }

    const task = state.tasks.find(item => Number(item.id) === taskId);
    const previousStatus = task?.status;
    const nextStatus = column.dataset.dropStatus;
    const oldColumn = draggedCard.closest('[data-drop-status]');
    clearHighlight();

    if (previousStatus === nextStatus) { cleanupDrag(); return; }

    // Move immediately in the DOM/state, then persist in the background. This removes
    // the full board reload that used to make large boards freeze after every drop.
    column.querySelector('.board-cards')?.appendChild(draggedCard);
    updateColumnCount(oldColumn);
    updateColumnCount(column);
    if (task) task.status = nextStatus;
    draggedCard.classList.remove('is-dragging');
    draggedCard.classList.add('is-saving');
    draggedCard.draggable = false;
    board.classList.remove('is-dragging');
    const savedCard = draggedCard;
    draggedCard = null;
    if (dragImage) dragImage.remove();
    dragImage = null;

    try {
      const updated = await api(`/api/tasks/${taskId}`, { method:'PATCH', body:{ status:nextStatus } });
      if (task && updated) Object.assign(task, updated);
      savedCard.classList.remove('is-saving');
      savedCard.draggable = true;
    } catch (error) {
      if (task) task.status = previousStatus;
      toast(error.message,'error');
      renderCurrentListView();
    }
  });

  board.addEventListener('dragend', cleanupDrag);
}

function renderCalendarView(mount) {
  const date = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth(), 1);
  const year = date.getFullYear(), month = date.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const start = new Date(year, month, 1 - firstDay);
  const cells = [];
  for (let i=0;i<42;i++) {
    const cellDate = new Date(start); cellDate.setDate(start.getDate()+i);
    const key = `${cellDate.getFullYear()}-${String(cellDate.getMonth()+1).padStart(2,'0')}-${String(cellDate.getDate()).padStart(2,'0')}`;
    const dayTasks = filteredTasks().filter(task => task.due_date === key);
    const todayKey = new Date().toISOString().slice(0,10);
    cells.push(`<div class="calendar-cell ${cellDate.getMonth()!==month?'outside':''} ${key===todayKey?'today':''}" data-calendar-date="${key}"><span class="day-number">${cellDate.getDate()}</span>${dayTasks.slice(0,4).map(task=>`<button class="calendar-task" data-open-task="${task.id}">${escapeHtml(task.title)}</button>`).join('')}${dayTasks.length>4?`<small>+${dayTasks.length-4} more</small>`:''}</div>`);
  }
  mount.innerHTML = `<div class="calendar-toolbar"><button data-calendar-nav="prev">‹</button><button data-calendar-nav="next">›</button><button data-calendar-nav="today">Today</button><h3>${date.toLocaleDateString(undefined,{month:'long',year:'numeric'})}</h3><div class="toolbar-spacer"></div><button class="add-task-btn" data-action="new-task">＋ Add Task</button></div><div style="overflow:auto"><div class="calendar-grid">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>`<div class="calendar-day-name">${day}</div>`).join('')}${cells.join('')}</div></div>`;
}
function renderListDashboard(mount) {
  const tasks = filteredTasks();
  const total = tasks.length, done = tasks.filter(t=>t.status==='done').length;
  const pct = total ? Math.round(done/total*100) : 0;
  const counts = Object.keys(STATUS).map(status=>({status,count:tasks.filter(t=>t.status===status).length}));
  const max = Math.max(1,...counts.map(i=>i.count));
  mount.innerHTML = `<div class="dashboard-page"><div class="dashboard-kpis"><div class="kpi-card"><small>Total tasks</small><strong>${total}</strong><div class="kpi-sub">In this List</div></div><div class="kpi-card"><small>Completed</small><strong>${done}</strong><div class="kpi-sub">${pct}% completion</div></div><div class="kpi-card"><small>In progress</small><strong>${tasks.filter(t=>t.status==='in_progress').length}</strong><div class="kpi-sub">Active work</div></div><div class="kpi-card"><small>Blocked</small><strong>${tasks.filter(t=>t.status==='blocked').length}</strong><div class="kpi-sub">Needs attention</div></div></div><div class="dashboard-grid"><div class="dash-card"><h3>Tasks by status</h3><div class="bar-list">${counts.map(item=>`<div class="bar-row"><span>${STATUS[item.status].short}</span><div class="bar-track"><div class="bar-fill" style="width:${item.count/max*100}%"></div></div><b>${item.count}</b></div>`).join('')}</div></div><div class="dash-card completion-card"><h3>Completion</h3><div class="progress-ring" style="--p:${pct}"><strong>${pct}%</strong></div></div></div></div>`;
}

async function renderWorkspaceDashboard() {
  const dashboard = await api(`/api/organizations/${state.org.id}/workspace-dashboard`); state.dashboard = dashboard;
  const statusMax = Math.max(1,...(dashboard.by_status||[]).map(x=>Number(x.count)));
  const workloadMax = Math.max(1,...(dashboard.workload||[]).map(x=>Number(x.count)));
  $('#contentMount').innerHTML = `<div class="simple-page"><div class="simple-page-header"><h2>Dashboards</h2><div class="page-actions"><button class="primary-btn">＋ Add card</button></div></div><div class="dashboard-page"><div class="dashboard-kpis"><div class="kpi-card"><small>Total tasks</small><strong>${dashboard.total_tasks}</strong></div><div class="kpi-card"><small>Completed</small><strong>${dashboard.completed_tasks}</strong></div><div class="kpi-card"><small>Completion</small><strong>${dashboard.completion_percent}%</strong></div><div class="kpi-card"><small>Open work</small><strong>${dashboard.total_tasks-dashboard.completed_tasks}</strong></div></div><div class="dashboard-grid"><div class="dash-card"><h3>Tasks by status</h3><div class="bar-list">${(dashboard.by_status||[]).map(item=>`<div class="bar-row"><span>${STATUS[item.status]?.short||item.status}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(item.count)/statusMax*100}%"></div></div><b>${item.count}</b></div>`).join('')||'<p>No task data yet.</p>'}</div></div><div class="dash-card"><h3>Workload</h3><div class="bar-list">${(dashboard.workload||[]).map(item=>`<div class="bar-row"><span>${escapeHtml(item.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(item.count)/workloadMax*100}%"></div></div><b>${item.count}</b></div>`).join('')||'<p>No assigned work yet.</p>'}</div></div></div><div class="dash-card" style="margin-top:12px"><h3>Due soon</h3>${dashboard.due_soon?.length?`<table class="dash-table"><thead><tr><th>Task</th><th>List</th><th>Assignee</th><th>Due</th><th>Priority</th></tr></thead><tbody>${dashboard.due_soon.map(task=>`<tr><td><button class="all-task-title" data-open-task="${task.id}" data-list-id="${task.list_id||''}">${escapeHtml(task.title)}</button></td><td>${escapeHtml(task.list_name||'')}</td><td>${escapeHtml(task.owner_name||'Unassigned')}</td><td class="${isOverdue(task)?'due-overdue':''}">${formatDate(task.due_date,{compact:true})}</td><td>${priorityMarkup(task.priority)}</td></tr>`).join('')}</tbody></table>`:'<p style="color:var(--muted)">No upcoming deadlines.</p>'}</div></div></div>`;
}

async function renderInbox() {
  const payload = await api('/api/users/me/notifications?limit=100');
  const notifications = payload.items || [];
  updateNotificationBadge(payload.unread_count || 0);
  $('#contentMount').innerHTML = `<div class="simple-page"><div class="simple-page-header"><h2>Inbox</h2><div class="page-actions"><button class="secondary-btn" data-action="mark-all-read">Mark all read</button></div></div><div class="simple-page-body"><div class="notification-list">${notifications.length ? notifications.map(item=>`<article class="notification-item ${item.read_at?'':'unread'}" data-notification="${item.id}"><span class="unread-dot" style="${item.read_at?'visibility:hidden':''}"></span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body||'')}</p></div><time>${relativeTime(item.created_at)}</time></article>`).join('') : `<div class="empty-state"><div><div class="empty-icon">♧</div><h3>Inbox zero</h3><p>You have no notifications right now.</p></div></div>`}</div></div></div>`;
}

async function renderChat() {
  if (!state.channels.length) state.channels = await api(`/api/organizations/${state.org.id}/channels`);
  state.currentChannel = state.currentChannel || state.channels[0] || null;
  if (state.currentChannel) state.messages = await api(`/api/channels/${state.currentChannel.id}/messages?limit=200`);
  $('#contentMount').innerHTML = `<div class="chat-layout"><aside class="chat-channels"><div class="chat-side-header"><strong>Chat</strong><button data-action="new-channel">＋</button></div><div class="channel-list">${state.channels.map(ch=>`<button class="channel-btn ${Number(ch.id)===Number(state.currentChannel?.id)?'active':''}" data-channel="${ch.id}"># ${escapeHtml(ch.name)}</button>`).join('')}</div></aside><section class="chat-main">${state.currentChannel ? `<div class="chat-header"><h3># ${escapeHtml(state.currentChannel.name)}</h3><small>${escapeHtml(state.currentChannel.topic||'')}</small></div><div id="messagesMount" class="messages">${renderMessages()}</div><div class="message-composer"><form id="messageForm"><textarea name="body" rows="2" placeholder="Message #${escapeHtml(state.currentChannel.name)}" required></textarea><button type="button" class="inline-ai-btn chat-ai-btn" data-action="ai-chat-draft">✦ AI</button><button type="submit" class="chat-send-btn">➤</button></form></div>` : `<div class="empty-state"><div><div class="empty-icon">◌</div><h3>No channels</h3><p>Create a channel to start a conversation.</p><button class="primary-btn" data-action="new-channel">Create channel</button></div></div>`}</section></div>`;
  $('#messageForm')?.addEventListener('submit', sendMessage);
  requestAnimationFrame(()=>{ const mount=$('#messagesMount'); if(mount) mount.scrollTop=mount.scrollHeight; });
  startChatRealtime();
}
function renderMessages() {
  return state.messages.map(msg=>`<article class="message">${avatarMarkup(msg,'message-avatar')}<div><div class="message-head"><strong>${escapeHtml(msg.full_name||msg.username)}</strong><time>${formatTime(msg.created_at)}</time></div><div class="message-body">${escapeHtml(msg.body)}</div></div></article>`).join('') || `<div class="empty-state" style="min-height:250px"><div><div class="empty-icon">#</div><h3>Start the conversation</h3><p>Messages sent here are visible to workspace members.</p></div></div>`;
}
async function applyChatAi(button) {
  if (!state.currentChannel) return;
  const target = $('#messageForm textarea');
  if (!target) return;
  button.classList.add('ai-working');
  try {
    const recent = state.messages.slice(-8).map(message => `${message.full_name || message.username}: ${message.body}`).join('\n');
    const result = await aiSuggestion({
      fieldName:'chat_message',
      fieldLabel:'Chat message',
      value:target.value.trim(),
      instruction:'Draft a concise, useful workspace chat message. If a draft already exists, improve it. Use the recent conversation only as context; do not invent decisions or facts.',
      formContext:{ channel:state.currentChannel.name, topic:state.currentChannel.topic || '', recent_messages:recent }
    });
    target.value = result.suggestion || target.value;
    target.dispatchEvent(new Event('input', { bubbles:true }));
    target.focus();
    aiAppliedToast(result, 'AI chat draft applied');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.classList.remove('ai-working'); }
}

function mergeLiveMessage(message, { scroll = true } = {}) {
  if (!message || !message.id || !state.currentChannel || Number(message.channel_id) !== Number(state.currentChannel.id)) return;
  const index = state.messages.findIndex(item => Number(item.id) === Number(message.id));
  if (index >= 0) state.messages[index] = message;
  else state.messages.push(message);
  state.messages.sort((a,b)=>Number(a.id)-Number(b.id));
  if (state.messages.length > 200) state.messages = state.messages.slice(-200);
  const mount = $('#messagesMount');
  if (mount) {
    const nearBottom = mount.scrollHeight - mount.scrollTop - mount.clientHeight < 100;
    mount.innerHTML = renderMessages();
    if (scroll || nearBottom) mount.scrollTop = mount.scrollHeight;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = $('textarea', form);
  const button = $('.chat-send-btn', form);
  const body = input.value.trim();
  if (!body || !state.currentChannel) return;
  input.value = '';
  if (button) button.disabled = true;
  try {
    const created = await api(`/api/channels/${state.currentChannel.id}/messages`, { method:'POST', body:{ body } });
    mergeLiveMessage(created, { scroll:true });
  } catch (error) {
    input.value = body;
    toast(error.message,'error');
  } finally {
    if (button) button.disabled = false;
    input.focus();
  }
}
async function refreshMessages() {
  if (state.globalView !== 'chat' || !state.currentChannel) return;
  const channelId = Number(state.currentChannel.id);
  const items = await api(`/api/channels/${channelId}/messages?limit=200`);
  if (state.globalView !== 'chat' || !state.currentChannel || Number(state.currentChannel.id) !== channelId) return;
  state.messages = items;
  const mount = $('#messagesMount'); if (mount) { mount.innerHTML = renderMessages(); mount.scrollTop = mount.scrollHeight; }
}
function startChatPoll() {
  stopChatPoll();
  if (state.currentChannel) state.chatPoll = setInterval(()=>refreshMessages().catch(()=>{}), 10000);
}
function stopChatPoll() { if (state.chatPoll) clearInterval(state.chatPoll); state.chatPoll = null; }
function stopChatRealtime() {
  if (state.chatStream) { try { state.chatStream.close(); } catch {} }
  state.chatStream = null;
  state.chatStreamChannelId = null;
  stopChatPoll();
}
function startChatRealtime() {
  stopChatRealtime();
  if (!state.currentChannel || state.globalView !== 'chat') return;
  const channelId = Number(state.currentChannel.id);
  state.chatStreamChannelId = channelId;
  startChatPoll(); // safety net if a proxy/network drops SSE
  if (!window.EventSource) return;
  const stream = new EventSource(`/api/channels/${channelId}/events`);
  state.chatStream = stream;
  stream.addEventListener('message', event => {
    if (state.globalView !== 'chat' || !state.currentChannel || Number(state.currentChannel.id) !== channelId) return;
    try { mergeLiveMessage(JSON.parse(event.data), { scroll:false }); } catch {}
  });
  stream.addEventListener('sync', event => {
    if (state.globalView !== 'chat' || Number(state.currentChannel?.id) !== channelId) return;
    try {
      const payload = JSON.parse(event.data);
      if (Array.isArray(payload.messages)) {
        state.messages = payload.messages;
        const mount = $('#messagesMount'); if (mount) { mount.innerHTML = renderMessages(); mount.scrollTop = mount.scrollHeight; }
      }
    } catch {}
  });
  stream.onerror = () => { /* EventSource reconnects automatically; polling remains active as fallback. */ };
}

async function renderDocs() {
  state.docs = await api(`/api/organizations/${state.org.id}/docs`);
  if (state.selectedDoc) state.selectedDoc = state.docs.find(doc=>Number(doc.id)===Number(state.selectedDoc.id)) || state.docs[0] || null;
  else state.selectedDoc = state.docs[0] || null;
  $('#contentMount').innerHTML = `<div class="docs-layout"><aside class="docs-list-panel"><div class="docs-panel-header"><strong>Docs</strong><button data-action="new-doc">＋</button></div><div class="docs-list">${state.docs.map(doc=>`<button class="doc-item ${Number(doc.id)===Number(state.selectedDoc?.id)?'active':''}" data-doc="${doc.id}"><strong>▱ ${escapeHtml(doc.title)}</strong><small>${relativeTime(doc.updated_at)} · ${escapeHtml(doc.updated_by_name||'')}</small></button>`).join('')||'<p style="padding:10px;color:var(--muted);font-size:11px">No Docs yet.</p>'}</div></aside><section class="doc-editor">${state.selectedDoc ? renderDocEditor(state.selectedDoc) : `<div class="doc-empty"><div><div class="empty-icon">▱</div><h3>Create your first Doc</h3><button class="primary-btn" data-action="new-doc">＋ New Doc</button></div></div>`}</section></div>`;
  bindDocEditor();
}
function renderDocEditor(doc) {
  return `<div class="doc-toolbar"><input id="docTitle" class="doc-title-input" value="${escapeHtml(doc.title)}"><span id="docSaveStatus" class="doc-save-status">Saved ${relativeTime(doc.updated_at)}</span><div class="doc-ai-actions"><button class="inline-ai-btn" data-action="ai-doc-draft">✦ Draft</button><button class="inline-ai-btn" data-action="ai-doc-continue">✦ Continue</button><button class="inline-ai-btn" data-action="ai-doc-summary">✦ Summarize</button></div><button class="secondary-btn" data-action="save-doc">Save</button><button class="secondary-btn" data-action="delete-doc">•••</button></div><div class="doc-editor-body"><textarea id="docContent" class="doc-content-editor" placeholder="Start writing…">${escapeHtml(doc.content||'')}</textarea></div>`;
}
function bindDocEditor() {
  let changed = false;
  ['docTitle','docContent'].forEach(id=> $(`#${id}`)?.addEventListener('input',()=>{changed=true; $('#docSaveStatus').textContent='Unsaved changes';}));
  if (changed) $('#docSaveStatus').textContent='Unsaved changes';
}
async function saveCurrentDoc() {
  if (!state.selectedDoc) return;
  const title = $('#docTitle')?.value.trim(); const content = $('#docContent')?.value || '';
  if (!title) return toast('Doc title is required','error');
  try {
    const updated = await api(`/api/docs/${state.selectedDoc.id}`, { method:'PATCH', body:{ title, content } });
    state.selectedDoc = updated; toast('Doc saved'); await renderDocs();
  } catch (error) { toast(error.message,'error'); }
}

function renderPeople() {
  $('#contentMount').innerHTML = `<div class="simple-page"><div class="simple-page-header"><h2>People</h2><div class="page-actions"><button class="primary-btn" data-action="invite-people">＋ Invite people</button></div></div><div class="simple-page-body"><div class="people-grid">${state.members.map(member=>{const ws=workStatusInfo(member);return `<article class="person-card"><div class="person-avatar">${member.avatar_url?`<img src="${escapeHtml(member.avatar_url)}" alt="">`:escapeHtml(initials(member.full_name))}</div><div><h4>${escapeHtml(member.full_name)}</h4><p>@${escapeHtml(member.username)} · ${escapeHtml(member.department||'General')}</p><div>${workStatusMarkup(member)}</div>${ws.note?`<p class="person-status-note">${escapeHtml(ws.note)}</p>`:''}<p class="person-presence-line"><span class="presence-dot ${member.current_status}"></span>${escapeHtml(member.current_status||'offline')} · ${escapeHtml(member.role)}</p></div></article>`}).join('')}</div></div></div>`;
}
function renderSettings() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const avatar = state.me?.avatar_url || '';
  const avatarPreview = avatar
    ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(state.me.full_name || state.me.username)} profile picture">`
    : `<span>${escapeHtml(initials(state.me?.full_name || state.me?.username))}</span>`;
  $('#contentMount').innerHTML = `<div class="simple-page"><div class="simple-page-header"><h2>Settings</h2></div><div class="simple-page-body"><div class="settings-grid"><nav class="settings-nav"><button class="active">Preferences</button><button>Notifications</button><button>Security</button></nav><section><div class="settings-section"><h3>Preferences</h3><div class="setting-row profile-picture-row"><div class="profile-picture-copy"><div id="settingsAvatarPreview" class="settings-avatar-preview">${avatarPreview}</div><div><strong>Profile picture</strong><p>Upload a square photo. FlowMate will resize it automatically.</p></div></div><div class="setting-actions"><input id="avatarFileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden><button class="secondary-btn" data-action="choose-avatar">Change photo</button>${avatar?'<button class="secondary-btn danger-text" data-action="remove-avatar">Remove</button>':''}</div></div><div class="setting-row"><div><strong>Dark mode</strong><p>Switch the workspace appearance.</p></div><button class="toggle ${dark?'on':''}" data-action="toggle-theme"></button></div><div class="setting-row"><div><strong>Profile</strong><p>${escapeHtml(state.me.full_name)} · ${escapeHtml(state.me.email)}</p></div><button class="secondary-btn" data-action="open-profile">View profile</button></div><div class="setting-row"><div><strong>Workspace</strong><p>${escapeHtml(state.org.name)} · ${escapeHtml(state.org.role)}</p></div><button class="secondary-btn" data-action="switch-workspace">Switch</button></div></div></section></div></div></div>`;
}

function compressAvatarFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Choose an image first.'));
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) return reject(new Error('Use a PNG, JPG, or WebP image.'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Choose an image smaller than 8 MB.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('That image could not be opened.'));
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('Image processing is not available in this browser.'));
        const sourceSize = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
        const sx = Math.max(0, ((image.naturalWidth || image.width) - sourceSize) / 2);
        const sy = Math.max(0, ((image.naturalHeight || image.height) - sourceSize) / 2);
        context.drawImage(image, sx, sy, sourceSize, sourceSize, 0, 0, size, size);
        let quality = 0.86;
        let dataUrl = canvas.toDataURL('image/webp', quality);
        while (dataUrl.length > 390000 && quality > 0.45) {
          quality -= 0.08;
          dataUrl = canvas.toDataURL('image/webp', quality);
        }
        if (dataUrl.length > 390000) return reject(new Error('The selected photo is still too large after compression. Try another image.'));
        resolve(dataUrl);
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function saveProfileAvatar(avatarValue, button = null) {
  setBusy(button, true, avatarValue ? 'Saving…' : 'Removing…');
  try {
    const updated = await api('/api/users/me/profile', { method:'PATCH', body:{ avatar_url:avatarValue } });
    state.me = { ...state.me, ...updated };
    state.members = state.members.map(member => Number(member.user_id) === Number(state.me.id) ? { ...member, avatar_url:updated.avatar_url || '' } : member);
    updateShellIdentity();
    renderSettings();
    toast(avatarValue ? 'Profile picture updated' : 'Profile picture removed');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
}

async function renderTaskDrawer(task = null, defaults = {}) {
  const isNew = !task;
  const list = state.currentList || findList(defaults.listId);
  const comments = task ? await api(`/api/tasks/${task.id}/comments`) : [];
  const timeEntries = task ? await api(`/api/tasks/${task.id}/time`) : [];
  state.taskTimerEntries = timeEntries;
  const tracked = timeEntries.reduce((sum,e)=>sum+Number(e.duration_seconds||0),0);
  const running = timeEntries.find(e=>!e.ended_at && Number(e.user_id)===Number(state.me.id));
  const values = task || { title:'', status:defaults.status||'not_started', priority:'medium', owner_id:'', start_date:'', due_date:defaults.dueDate||'', estimate_minutes:0, description:'', parent_task_id:defaults.parentTaskId||null };
  const isTopLevel = !Number(values.parent_task_id || 0);
  const ownerLabel = isTopLevel ? 'Manager / Owner' : 'Assignee';
  $('#taskDrawer').innerHTML = `<div class="drawer-head"><span class="drawer-location">${escapeHtml([list?.space_name,list?.folder_name,list?.name].filter(Boolean).join(' / ') || 'Task')}</span><div class="drawer-head-spacer"></div>${task?`<button data-action="copy-task-link" title="Copy link">⛓</button>`:''}<button data-action="close-task" title="Close">×</button></div><div class="task-drawer-body"><form id="taskEditForm"><div class="task-title-editor"><span class="task-status-circle"></span><input id="taskTitleEdit" class="task-title-input" value="${escapeHtml(values.title)}" placeholder="Task name" required><button type="button" class="inline-ai-btn" data-ai-task="title">✦ AI title</button></div><div class="task-properties"><div class="property-row"><span class="property-label">Status</span><select name="status">${Object.keys(STATUS).map(s=>`<option value="${s}" ${values.status===s?'selected':''}>${STATUS[s].short}</option>`).join('')}</select></div><div class="property-row"><span class="property-label">${ownerLabel}</span><select name="owner_id"><option value="">Unassigned</option>${state.members.filter(m=>m.status==='active').map(m=>`<option value="${m.user_id}" ${Number(values.owner_id)===Number(m.user_id)?'selected':''}>${escapeHtml(m.full_name)}</option>`).join('')}</select></div><div class="property-row"><span class="property-label">Priority</span><select name="priority">${Object.keys(PRIORITY).map(p=>`<option value="${p}" ${values.priority===p?'selected':''}>${PRIORITY[p]}</option>`).join('')}</select></div><div class="property-row"><span class="property-label">Due date</span><input type="date" name="due_date" value="${escapeHtml(values.due_date||'')}"></div><div class="property-row"><span class="property-label">Start date</span><input type="date" name="start_date" value="${escapeHtml(values.start_date||'')}"></div><div class="property-row"><span class="property-label">Estimate</span><input type="number" min="0" name="estimate_minutes" value="${Number(values.estimate_minutes||0)}" placeholder="minutes"></div></div><section class="task-section"><div class="task-section-title"><h4>Description</h4><button type="button" class="inline-ai-btn" data-ai-task="description">✦ AI write</button></div><textarea class="description-editor" name="description" placeholder="Add a description…">${escapeHtml(values.description||'')}</textarea></section>${task?`<section class="task-section"><div class="task-section-title"><h4>Subtasks</h4><div class="task-section-actions"><button type="button" class="secondary-btn compact-btn" data-action="add-subtask">＋ Add one</button><button type="button" class="secondary-btn compact-btn" data-action="manual-divide">☷ Manual divide</button></div></div><div class="subtask-mini-list">${state.tasks.filter(item=>Number(item.parent_task_id)===Number(task.id)&&!item.rejected).map(item=>`<button type="button" class="subtask-mini-row" data-open-task="${item.id}"><span>${item.status==='done'?'✓':'○'}</span><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.owner_name||'Unassigned')}</small></button>`).join('')||'<p class="muted-help">No subtasks yet.</p>'}</div></section><section class="task-section"><h4>Time tracking</h4><div class="task-actions-row"><button type="button" class="timer-btn ${running?'running':''}" data-action="toggle-timer">${running?'■ Stop timer':'▶ Start timer'}</button><span class="tracked-time">Tracked: ${durationText(tracked)}${running?' + running':''}</span></div></section><section class="task-section"><h4>Activity & comments</h4><div id="commentsList" class="comments-list">${renderComments(comments)}</div><div class="comment-form"><input id="commentInput" placeholder="Write a comment…"><button type="button" class="inline-ai-btn" data-ai-task="comment" title="Draft with AI">✦</button><button type="button" data-action="add-comment">➤</button></div></section>`:''}</form></div><div class="drawer-savebar">${task?`<button class="danger-btn" data-action="delete-task">Delete</button>`:''}<div style="flex:1"></div><button class="secondary-btn" data-action="close-task">Cancel</button>${isNew?`<button class="secondary-btn" data-action="save-task-divide">Create & divide</button>`:''}<button class="primary-btn" data-action="save-task">${isNew?'Create task':'Save changes'}</button></div>`;
  $('#taskDrawer').dataset.parentTaskId = isNew && defaults.parentTaskId ? String(defaults.parentTaskId) : '';
  $('#taskDrawerBackdrop').classList.remove('hidden'); $('#taskDrawer').classList.remove('hidden');
}
function renderComments(comments) {
  return comments.map(comment=>`<article class="comment">${avatarMarkup(comment,'comment-avatar')}<div><div class="comment-head"><strong>${escapeHtml(comment.full_name||comment.username)}</strong><time>${relativeTime(comment.created_at)}</time></div><p>${escapeHtml(comment.body)}</p></div></article>`).join('') || '<p style="color:var(--muted);font-size:11px">No comments yet.</p>';
}
async function openTaskDrawer(taskId = null, defaults = {}) {
  try {
    if (defaults.listId && (!state.currentList || Number(state.currentList.id)!==Number(defaults.listId))) state.currentList = findList(defaults.listId) || state.currentList;
    state.selectedTaskId = taskId;
    const task = taskId ? await api(`/api/tasks/${taskId}`) : null;
    await renderTaskDrawer(task, defaults);
  } catch (error) { toast(error.message,'error'); }
}
function closeTaskDrawer() {
  state.selectedTaskId = null; $('#taskDrawer').classList.add('hidden'); $('#taskDrawerBackdrop').classList.add('hidden');
}
async function saveTaskFromDrawer({ openBreakdown = false } = {}) {
  const form = $('#taskEditForm'); if (!form) return null;
  const title = $('#taskTitleEdit').value.trim(); if (!title) { toast('Task name is required','error'); return null; }
  const fd = Object.fromEntries(new FormData(form));
  const body = { title, description:fd.description||'', status:fd.status, priority:fd.priority, owner_id:fd.owner_id?Number(fd.owner_id):null, due_date:fd.due_date||null, start_date:fd.start_date||null, estimate_minutes:Number(fd.estimate_minutes||0), parent_task_id:$('#taskDrawer').dataset.parentTaskId?Number($('#taskDrawer').dataset.parentTaskId):null };
  try {
    const wasNew = !state.selectedTaskId;
    let savedTask;
    if (state.selectedTaskId) savedTask = await api(`/api/tasks/${state.selectedTaskId}`, { method:'PATCH', body });
    else {
      if (!state.currentList) { toast('Create or select a List first','error'); return null; }
      savedTask = await api(`/api/lists/${state.currentList.id}/tasks`, { method:'POST', body });
      state.selectedTaskId = savedTask.id;
    }
    const savedId = Number(savedTask?.id || state.selectedTaskId);
    toast(wasNew ? 'Task created' : 'Task saved');
    await refreshAfterTaskChange();
    closeTaskDrawer();
    if (openBreakdown && savedId) await openManualBreakdown(savedId);
    return savedId;
  } catch (error) { toast(error.message,'error'); return null; }
}

function blankManualSubtask() {
  return { title:'', description:'', assignee_id:'', priority:'medium', estimate_minutes:180, children:[] };
}
function blankManualChild() {
  return { title:'', description:'', assignee_id:'', priority:'medium', estimate_minutes:90 };
}
function manualMemberOptions(selected = '') {
  return `<option value="">Unassigned</option>${state.members.filter(member=>member.status==='active').map(member=>`<option value="${member.user_id}" ${Number(selected)===Number(member.user_id)?'selected':''}>${escapeHtml(member.full_name)} · ${escapeHtml(member.department||'General')}</option>`).join('')}`;
}
async function openManualBreakdown(parentTaskId) {
  try {
    const parent = state.tasks.find(task=>Number(task.id)===Number(parentTaskId)) || state.allTasks.find(task=>Number(task.id)===Number(parentTaskId)) || await api(`/api/tasks/${parentTaskId}`);
    state.manualBreakdownParent = parent;
    state.manualBreakdownDraft = [blankManualSubtask(), blankManualSubtask(), blankManualSubtask()];
    renderManualBreakdown();
    $('#manualBreakdownDialog').showModal();
  } catch (error) { toast(error.message,'error'); }
}
function renderManualBreakdown() {
  const parent = state.manualBreakdownParent;
  if (!parent) return;
  $('#manualBreakdownParent').innerHTML = `<span class="main-task-badge">PARENT</span><div><strong>${escapeHtml(parent.title)}</strong><small>${escapeHtml(parent.owner_name ? `Manager / owner: ${parent.owner_name}` : 'No manager / owner assigned yet')}</small></div>`;
  $('#manualBreakdownRows').innerHTML = state.manualBreakdownDraft.map((sub,index)=>`<article class="manual-sub-card" data-manual-sub="${index}">
    <div class="manual-sub-head"><span>SUBTASK ${index+1}</span><button type="button" class="text-btn danger-text" data-manual-remove-sub="${index}">Remove</button></div>
    <div class="manual-grid">
      <label class="manual-wide">Title<input data-manual-sub-field="title" data-sub-index="${index}" value="${escapeHtml(sub.title)}" placeholder="Concrete work item"></label>
      <label>Assignee<select data-manual-sub-field="assignee_id" data-sub-index="${index}">${manualMemberOptions(sub.assignee_id)}</select></label>
      <label>Priority<select data-manual-sub-field="priority" data-sub-index="${index}">${Object.keys(PRIORITY).map(p=>`<option value="${p}" ${sub.priority===p?'selected':''}>${PRIORITY[p]}</option>`).join('')}</select></label>
      <label>Estimate (min)<input type="number" min="0" data-manual-sub-field="estimate_minutes" data-sub-index="${index}" value="${Number(sub.estimate_minutes||0)}"></label>
      <label class="manual-full">Description<textarea rows="2" data-manual-sub-field="description" data-sub-index="${index}" placeholder="What should this person deliver?">${escapeHtml(sub.description||'')}</textarea></label>
    </div>
    <div class="manual-child-head"><strong>Nested steps</strong><button type="button" class="secondary-btn compact-btn" data-manual-add-child="${index}">＋ Add nested step</button></div>
    <div class="manual-child-list">${(sub.children||[]).map((child,childIndex)=>`<div class="manual-child-row">
      <span class="manual-branch">↳</span><input data-manual-child-field="title" data-sub-index="${index}" data-child-index="${childIndex}" value="${escapeHtml(child.title)}" placeholder="Smaller execution step">
      <select data-manual-child-field="assignee_id" data-sub-index="${index}" data-child-index="${childIndex}">${manualMemberOptions(child.assignee_id)}</select>
      <select data-manual-child-field="priority" data-sub-index="${index}" data-child-index="${childIndex}">${Object.keys(PRIORITY).map(p=>`<option value="${p}" ${child.priority===p?'selected':''}>${PRIORITY[p]}</option>`).join('')}</select>
      <input type="number" min="0" data-manual-child-field="estimate_minutes" data-sub-index="${index}" data-child-index="${childIndex}" value="${Number(child.estimate_minutes||0)}" title="Estimate minutes">
      <button type="button" class="icon-close small" data-manual-remove-child="${index}:${childIndex}">×</button>
    </div>`).join('') || '<p class="muted-help">Use nested steps when this subtask is still too large for one person to execute clearly.</p>'}</div>
  </article>`).join('');
}
async function saveManualBreakdown() {
  const parent = state.manualBreakdownParent;
  if (!parent || !state.currentList) return toast('Open the task from a List before dividing it.','error');
  const valid = state.manualBreakdownDraft.filter(sub=>String(sub.title||'').trim());
  if (!valid.length) return toast('Add at least one subtask title.','error');
  const button = $('#saveManualBreakdownBtn'); setBusy(button,true,'Creating…');
  try {
    let directCount = 0, nestedCount = 0;
    for (const sub of valid) {
      const created = await api(`/api/lists/${state.currentList.id}/tasks`, { method:'POST', body:{
        parent_task_id:Number(parent.id), title:String(sub.title).trim(), description:String(sub.description||'').trim(),
        owner_id:sub.assignee_id?Number(sub.assignee_id):null, priority:sub.priority||'medium', status:'not_started', estimate_minutes:Number(sub.estimate_minutes||0)
      }});
      directCount += 1;
      for (const child of (sub.children||[]).filter(item=>String(item.title||'').trim())) {
        await api(`/api/lists/${state.currentList.id}/tasks`, { method:'POST', body:{
          parent_task_id:Number(created.id), title:String(child.title).trim(), description:String(child.description||'').trim(),
          owner_id:child.assignee_id?Number(child.assignee_id):null, priority:child.priority||'medium', status:'not_started', estimate_minutes:Number(child.estimate_minutes||0)
        }});
        nestedCount += 1;
      }
    }
    $('#manualBreakdownDialog').close();
    state.manualBreakdownParent = null; state.manualBreakdownDraft = [];
    await refreshAfterTaskChange();
    toast(`Created ${directCount} subtasks${nestedCount?` + ${nestedCount} nested steps`:''}`);
  } catch (error) { toast(error.message,'error'); }
  finally { setBusy(button,false); }
}

async function refreshAfterTaskChange() {
  if (state.currentList) await loadListTasks();
  const [tree, projects] = await Promise.all([api(`/api/organizations/${state.org.id}/workspace-tree`), api(`/api/organizations/${state.org.id}/projects`)]); state.tree = tree; state.projects = projects || []; renderSidebar();
  if (state.globalView === 'list') renderListShell();
  else if (state.globalView === 'home') await renderHome();
  else if (state.globalView === 'all' || state.globalView === 'me') await renderAllTasks(state.globalView);
  else if (state.globalView === 'dashboard') await renderWorkspaceDashboard();
}
async function toggleTaskComplete(taskId) {
  const task = state.tasks.find(t=>Number(t.id)===Number(taskId)) || state.allTasks.find(t=>Number(t.id)===Number(taskId)); if (!task) return;
  try { await api(`/api/tasks/${taskId}`, { method:'PATCH', body:{ status:task.status==='done'?'not_started':'done' } }); await refreshAfterTaskChange(); }
  catch (error) { toast(error.message,'error'); }
}
async function addComment() {
  const input = $('#commentInput'); const body = input?.value.trim(); if (!body || !state.selectedTaskId) return;
  try { await api(`/api/tasks/${state.selectedTaskId}/comments`, { method:'POST', body:{ body } }); input.value=''; const comments = await api(`/api/tasks/${state.selectedTaskId}/comments`); $('#commentsList').innerHTML = renderComments(comments); }
  catch (error) { toast(error.message,'error'); }
}
async function toggleTimer() {
  if (!state.selectedTaskId) return;
  const running = state.taskTimerEntries.find(e=>!e.ended_at && Number(e.user_id)===Number(state.me.id));
  try { await api(`/api/tasks/${state.selectedTaskId}/time/${running?'stop':'start'}`, { method:'POST', body:{} }); const task = await api(`/api/tasks/${state.selectedTaskId}`); await renderTaskDrawer(task); }
  catch (error) { toast(error.message,'error'); }
}
async function deleteSelectedTask() {
  if (!state.selectedTaskId || !confirm('Delete this task permanently?')) return;
  try { await api(`/api/tasks/${state.selectedTaskId}`, { method:'DELETE' }); closeTaskDrawer(); toast('Task deleted'); await refreshAfterTaskChange(); }
  catch (error) { toast(error.message,'error'); }
}

function openEntityDialog(action, context = {}) {
  state.entityAction = action; state.entityContext = context;
  const dialog = $('#entityDialog'), fields = $('#entityFields');
  const config = entityConfig(action, context);
  $('#entityEyebrow').textContent = config.eyebrow || 'CREATE'; $('#entityTitle').textContent = config.title; $('#entitySubmit').textContent = config.submit || 'Create';
  fields.innerHTML = config.html; dialog.showModal();
  setTimeout(()=> $('input,textarea,select',fields)?.focus(),50);
}
function entityConfig(action, ctx) {
  if (action==='space') return {title:'Create Space',html:`<label>Space name<input name="name" required placeholder="e.g. Marketing"></label><div class="form-grid"><label>Icon<input name="icon" value="◫" maxlength="8"></label><label>Color<input name="color" type="color" value="#7b68ee"></label></div><label>Description<textarea name="description" rows="3" placeholder="What belongs in this Space?"></textarea></label>`};
  if (action==='folder') return {title:'Create Folder',html:`<label>Folder name<input name="name" required placeholder="e.g. Q3 Campaigns"></label>`};
  if (action==='list') return {title:'Create List',html:`<label>List name<input name="name" required placeholder="e.g. Website Launch"></label><label>Description<textarea name="description" rows="3" placeholder="What work belongs here?"></textarea></label>`};
  if (action==='view') return {title:'Create View',submit:'Add view',html:`<label>View name<input name="name" required maxlength="80" placeholder="e.g. Client Board"></label><label>View type<select name="view_type"><option value="list">List</option><option value="board">Board</option><option value="calendar">Calendar</option><option value="dashboard">Dashboard</option></select></label><p class="muted-help">This view is saved for this project and your account.</p>`};
  if (action==='channel') return {title:'Create Channel',html:`<label>Channel name<input name="name" required placeholder="e.g. design-team"></label><label>Topic<textarea name="topic" rows="3" placeholder="What is this channel for?"></textarea></label>`};
  if (action==='invite') return {title:'Invite to Workspace',html:`<label>Username or email<input name="target" required placeholder="teammate@example.com"></label><div class="form-grid"><label>Role<select name="role"><option value="member">Member</option><option value="moderator">Moderator</option>${state.org.role==='ceo'?'<option value="admin">Admin</option>':''}</select></label><label>Department<input name="department" value="General"></label></div>`};
  if (action==='workspace') return {title:'Create Workspace',html:`<label>Workspace name<input name="name" required placeholder="e.g. Client Projects"></label>`};
  if (action==='rename-space') return {eyebrow:'EDIT',title:'Rename Space',submit:'Save',html:`<label>Space name<input name="name" required value="${escapeHtml(findSpace(ctx.id)?.name||'')}"></label>`};
  if (action==='rename-folder') return {eyebrow:'EDIT',title:'Rename Folder',submit:'Save',html:`<label>Folder name<input name="name" required value="${escapeHtml(findFolder(ctx.id)?.name||'')}"></label>`};
  if (action==='rename-list') return {eyebrow:'EDIT',title:'Rename List',submit:'Save',html:`<label>List name<input name="name" required value="${escapeHtml(findList(ctx.id)?.name||'')}"></label>`};
  return {title:'Create',html:'<label>Name<input name="name" required></label>'};
}
$('#entityForm').addEventListener('submit', async event => {
  event.preventDefault(); const fd = Object.fromEntries(new FormData(event.currentTarget)); const action = state.entityAction, ctx = state.entityContext || {}; const button = $('#entitySubmit'); let inviteLink = ''; let inviteCopied = false; setBusy(button,true,'Saving…');
  try {
    if (action==='space') await api(`/api/organizations/${state.org.id}/spaces`,{method:'POST',body:fd});
    else if (action==='folder') await api(`/api/spaces/${ctx.spaceId}/folders`,{method:'POST',body:fd});
    else if (action==='list') {
      const path = ctx.folderId ? `/api/folders/${ctx.folderId}/lists` : `/api/spaces/${ctx.spaceId}/lists`;
      await api(path,{method:'POST',body:fd});
    }
    else if (action==='channel') await api(`/api/organizations/${state.org.id}/channels`,{method:'POST',body:fd});
    else if (action==='view') {
      if (!state.currentList) throw new Error('Open a project first.');
      const createdView = await api(`/api/lists/${state.currentList.id}/views`,{method:'POST',body:{name:fd.name,view_type:fd.view_type}});
      state.customViews.push(createdView);
      state.activeCustomViewId = Number(createdView.id);
      state.listView = createdView.view_type;
      localStorage.setItem(`flowmate-list-view-${state.currentList.id}`, `custom:${createdView.id}`);
    }
    else if (action==='invite') { const invitation = await api(`/api/organizations/${state.org.id}/invitations`,{method:'POST',body:{ identifier:fd.target, proposed_role:fd.role, proposed_department:fd.department }}); inviteLink = invitation.invite_url || ''; if (inviteLink) { try { await navigator.clipboard.writeText(inviteLink); inviteCopied = true; } catch {} } }
    else if (action==='workspace') await api('/api/organizations',{method:'POST',body:fd});
    else if (action==='rename-space') await api(`/api/spaces/${ctx.id}`,{method:'PATCH',body:{name:fd.name}});
    else if (action==='rename-folder') await api(`/api/folders/${ctx.id}`,{method:'PATCH',body:{name:fd.name}});
    else if (action==='rename-list') await api(`/api/lists/${ctx.id}`,{method:'PATCH',body:{name:fd.name}});
    $('#entityDialog').close(); toast(inviteLink ? (inviteCopied ? 'Invitation created · invite link copied' : `Invitation created · share this link: ${inviteLink}`) : 'Saved');
    const me = await api('/api/auth/me'); state.organizations = (me.organizations||[]).filter(o=>o.membership_status==='active');
    if (action==='workspace') { const newest=state.organizations[state.organizations.length-1]; if(newest) await selectOrganization(newest.id); }
    else if (action==='view') { renderListShell(); }
    else {
      const previousView = state.globalView;
      const previousSpaceId = state.activeSpaceId;
      await selectOrganization(state.org.id,false);
      if(action==='channel') await renderChat();
      else if(action==='space') await renderSpaceOverview(state.tree[state.tree.length-1]?.id || previousSpaceId);
      else if(previousView==='projects') renderProjectsOverview();
      else if(previousView==='space' && previousSpaceId) await renderSpaceOverview(previousSpaceId);
      else if(previousView==='list') await openList(state.currentList?.id||flattenLists()[0]?.id);
    }
  } catch (error) { toast(error.message,'error'); }
  finally { setBusy(button,false); }
});
$('#entityDialog .icon-close').addEventListener('click',()=>$('#entityDialog').close());
$('#entityDialog .secondary-btn').addEventListener('click',event=>{event.preventDefault();$('#entityDialog').close();});

function openTreeMenu(type,id,anchor) {
  closeContextMenu(); const rect=anchor.getBoundingClientRect(); const menu=document.createElement('div'); menu.className='context-menu'; menu.id='contextMenu';
  let buttons='';
  if(type==='space') buttons=`<button data-menu-action="add-folder">＋ New Folder</button><button data-menu-action="add-list">＋ New List</button><button data-menu-action="rename">Rename</button><button class="danger" data-menu-action="delete">Delete Space</button>`;
  if(type==='folder') buttons=`<button data-menu-action="add-list">＋ New List</button><button data-menu-action="rename">Rename</button><button class="danger" data-menu-action="delete">Delete Folder</button>`;
  if(type==='list') buttons=`<button data-menu-action="open">Open</button><button data-menu-action="rename">Rename</button><button class="danger" data-menu-action="delete">Delete List</button>`;
  menu.innerHTML=buttons; menu.style.left=`${Math.min(innerWidth-190,rect.right)}px`; menu.style.top=`${Math.min(innerHeight-180,rect.top)}px`; document.body.appendChild(menu);
  menu.addEventListener('click',async event=>{
    const action=event.target.dataset.menuAction;if(!action)return;closeContextMenu();
    if(action==='add-folder') openEntityDialog('folder',{spaceId:id});
    else if(action==='add-list') { if(type==='space')openEntityDialog('list',{spaceId:id}); else if(type==='folder'){const f=findFolder(id);openEntityDialog('list',{spaceId:f.space_id,folderId:id});} }
    else if(action==='open'&&type==='list') openList(id);
    else if(action==='rename') openEntityDialog(`rename-${type}`,{id});
    else if(action==='delete') await deleteTreeEntity(type,id);
  });
  setTimeout(()=>document.addEventListener('click',closeContextMenu,{once:true}),0);
}
function closeContextMenu(){ $('#contextMenu')?.remove(); }
async function deleteTreeEntity(type,id){
  if(!confirm(`Delete this ${type} and its contained work?`))return;
  try{await api(`/api/${type==='list'?'lists':type==='folder'?'folders':'spaces'}/${id}`,{method:'DELETE'});toast(`${type[0].toUpperCase()+type.slice(1)} deleted`);await selectOrganization(state.org.id,false);const lists=flattenLists();if(lists.length)await openList(lists[0].id);else setGlobalView('home');}catch(error){toast(error.message,'error')}
}

function openWorkspaceMenu(anchor) {
  closeContextMenu(); const rect=anchor.getBoundingClientRect(); const menu=document.createElement('div');menu.className='context-menu';menu.id='contextMenu';
  menu.innerHTML=state.organizations.map(org=>`<button data-org-switch="${org.id}">${Number(org.id)===Number(state.org.id)?'✓ ':''}${escapeHtml(org.name)}</button>`).join('')+`<button data-new-workspace="1">＋ New Workspace</button>`;
  menu.style.left=`${rect.left}px`;menu.style.top=`${rect.bottom+4}px`;document.body.appendChild(menu);
  menu.addEventListener('click',async event=>{const id=Number(event.target.dataset.orgSwitch);if(id){closeContextMenu();await selectOrganization(id);return}if(event.target.dataset.newWorkspace){closeContextMenu();openEntityDialog('workspace')}});
  setTimeout(()=>document.addEventListener('click',closeContextMenu,{once:true}),0);
}
$('#workspaceSwitcherBtn').addEventListener('click',event=>{event.stopPropagation();openWorkspaceMenu(event.currentTarget)});
$('#sidebarCreateBtn').addEventListener('click',()=>openQuickCreateMenu($('#sidebarCreateBtn')));
$('#globalNewBtn').addEventListener('click',()=>openQuickCreateMenu($('#globalNewBtn')));
function openQuickCreateMenu(anchor){
  closeContextMenu();const rect=anchor.getBoundingClientRect();const menu=document.createElement('div');menu.className='context-menu';menu.id='contextMenu';const spaceOption=state.org?.role==='ceo'?'<button data-qcreate="space">◫ Space</button>':'';menu.innerHTML=`<button data-qcreate="ai-project">✦ AI Project Plan</button><button data-qcreate="task">✓ Task</button><button data-qcreate="doc">▱ Doc</button>${spaceOption}<button data-qcreate="channel"># Channel</button>`;menu.style.left=`${Math.max(8,Math.min(innerWidth-190,rect.right-180))}px`;menu.style.top=`${Math.min(innerHeight-150,rect.bottom+5)}px`;document.body.appendChild(menu);menu.addEventListener('click',event=>{const action=event.target.dataset.qcreate;if(!action)return;closeContextMenu();if(action==='ai-project'){if(!state.tree.length)return state.org?.role==='ceo'?openEntityDialog('space'):toast('A CEO must create a Space first.','error');openAiProjectPlanner()}if(action==='task')openTaskDrawer();if(action==='doc')createDoc();if(action==='space'&&state.org?.role==='ceo')openEntityDialog('space');if(action==='channel')openEntityDialog('channel')});setTimeout(()=>document.addEventListener('click',closeContextMenu,{once:true}),0);
}

$('#newSpaceBtn').addEventListener('click',()=>{if(state.org?.role==='ceo')openEntityDialog('space');else toast('Only the CEO can create Spaces.','error')});
$('#invitePeopleBtn').addEventListener('click',()=>openEntityDialog('invite'));
$('#spaceSearchBtn').addEventListener('click',()=>openCommandDialog(''));

async function createDoc() {
  try { const doc=await api(`/api/organizations/${state.org.id}/docs`,{method:'POST',body:{title:'Untitled Doc',content:'',space_id:state.currentList?.space_id||null,list_id:state.currentList?.id||null}}); state.selectedDoc=doc; await setGlobalView('docs'); setTimeout(()=>$('#docTitle')?.select(),30); }
  catch(error){toast(error.message,'error')}
}

function openCommandDialog(seed='') {
  const dialog=$('#commandDialog');$('#commandInput').value=seed;dialog.showModal();renderCommandResults(seed);setTimeout(()=>$('#commandInput').focus(),40);
}
$('#commandSearchBtn').addEventListener('click',()=>openCommandDialog());
$('#commandInput').addEventListener('input',event=>{clearTimeout(state.commandTimer);state.commandTimer=setTimeout(()=>renderCommandResults(event.target.value),180)});
async function renderCommandResults(query) {
  const mount=$('#commandResults');const q=query.trim();
  if(!q){mount.innerHTML=`<div class="command-section-label">Quick actions</div><button class="command-result" data-command-action="ai-project"><span class="command-result-icon">✦</span><span class="command-result-copy"><strong>Plan project with AI</strong><small>Brief → managers → tasks → nested subtasks</small></span></button><button class="command-result" data-command-action="new-task"><span class="command-result-icon">✓</span><span class="command-result-copy"><strong>Create task</strong><small>In the current List</small></span></button><button class="command-result" data-command-action="new-doc"><span class="command-result-icon">▱</span><span class="command-result-copy"><strong>Create Doc</strong><small>Start a new page</small></span></button><button class="command-result" data-command-action="dashboard"><span class="command-result-icon">▦</span><span class="command-result-copy"><strong>Open Dashboards</strong><small>Workspace reporting</small></span></button>`;return}
  try{
    const tasks=await api(`/api/organizations/${state.org.id}/tasks?scope=all&search=${encodeURIComponent(q)}`);const docs=state.docs.filter(doc=>doc.title.toLowerCase().includes(q.toLowerCase())).slice(0,8);const people=state.members.filter(m=>`${m.full_name} ${m.username}`.toLowerCase().includes(q.toLowerCase())).slice(0,6);
    mount.innerHTML=`${tasks.length?'<div class="command-section-label">Tasks</div>':''}${tasks.slice(0,10).map(t=>`<button class="command-result" data-command-task="${t.id}" data-list-id="${t.list_id||''}"><span class="command-result-icon">✓</span><span class="command-result-copy"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml([t.space_name,t.list_name].filter(Boolean).join(' / '))}</small></span></button>`).join('')}${docs.length?'<div class="command-section-label">Docs</div>':''}${docs.map(d=>`<button class="command-result" data-command-doc="${d.id}"><span class="command-result-icon">▱</span><span class="command-result-copy"><strong>${escapeHtml(d.title)}</strong><small>Doc</small></span></button>`).join('')}${people.length?'<div class="command-section-label">People</div>':''}${people.map(p=>`<button class="command-result"><span class="command-result-icon">${escapeHtml(initials(p.full_name))}</span><span class="command-result-copy"><strong>${escapeHtml(p.full_name)}</strong><small>@${escapeHtml(p.username)}</small></span></button>`).join('')}${!tasks.length&&!docs.length&&!people.length?'<div class="empty-state" style="min-height:150px"><p>No matching workspace items.</p></div>':''}`;
  }catch(error){mount.innerHTML=`<p style="padding:12px;color:var(--danger)">${escapeHtml(error.message)}</p>`}
}
$('#commandResults').addEventListener('click',async event=>{const row=event.target.closest('button');if(!row)return;$('#commandDialog').close();if(row.dataset.commandTask){const listId=Number(row.dataset.listId);if(listId)state.currentList=findList(listId)||state.currentList;openTaskDrawer(Number(row.dataset.commandTask),{listId});}else if(row.dataset.commandDoc){state.selectedDoc=state.docs.find(d=>Number(d.id)===Number(row.dataset.commandDoc));setGlobalView('docs')}else if(row.dataset.commandAction==='ai-project')openAiProjectPlanner();else if(row.dataset.commandAction==='new-task')openTaskDrawer();else if(row.dataset.commandAction==='new-doc')createDoc();else if(row.dataset.commandAction==='dashboard')setGlobalView('dashboard')});

async function aiSuggestion({ fieldName, fieldLabel, value = '', instruction = '', formContext = {}, projectId = null }) {
  const result = await api('/api/ai/suggest', { method:'POST', body:{
    field_name:fieldName,
    field_label:fieldLabel,
    value,
    instruction,
    project_id:projectId || state.currentList?.project_id || null,
    form_context:{ workspace:state.org?.name || 'Personal', list:state.currentList?.name || '', ...formContext }
  }});
  state.aiStatus = { provider:result.provider, fallback:result.fallback };
  return result;
}
function aiAppliedToast(result, message = 'AI suggestion applied') {
  const mode = result?.fallback ? 'local fallback' : (result?.provider || 'AI');
  toast(`${message} · ${mode}`);
}
async function applyTaskAi(kind, button) {
  const form = $('#taskEditForm'); if (!form) return;
  const title = $('#taskTitleEdit')?.value || '';
  const description = $('textarea[name="description"]', form)?.value || '';
  const status = $('select[name="status"]', form)?.value || 'not_started';
  const priority = $('select[name="priority"]', form)?.value || 'medium';
  let target, fieldName, fieldLabel, value, instruction;
  if (kind === 'title') {
    target = $('#taskTitleEdit'); fieldName = 'task_title'; fieldLabel = 'Task title'; value = title;
    instruction = 'Create or improve this into one concise, action-oriented task title. Keep it specific and under 80 characters.';
  } else if (kind === 'description') {
    target = $('textarea[name="description"]', form); fieldName = 'task_description'; fieldLabel = 'Task description'; value = description;
    instruction = 'Write or improve a practical task description. Include the expected outcome, important steps or constraints, and how completion can be verified. Do not invent facts.';
  } else {
    target = $('#commentInput'); fieldName = 'task_comment'; fieldLabel = 'Task comment'; value = target?.value || '';
    instruction = 'Draft a concise, professional progress comment for this task using only the supplied task context. Mention next step or blocker only if supported.';
  }
  if (!target) return;
  button.classList.add('ai-working');
  try {
    const result = await aiSuggestion({ fieldName, fieldLabel, value, instruction, formContext:{ task_title:title, task_description:description, task_status:status, task_priority:priority } });
    target.value = result.suggestion || value;
    target.dispatchEvent(new Event('input', { bubbles:true }));
    aiAppliedToast(result);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.classList.remove('ai-working'); }
}
async function applyDocAi(mode, button) {
  const title = $('#docTitle')?.value || state.selectedDoc?.title || 'Untitled Doc';
  const target = $('#docContent'); if (!target) return;
  const current = target.value || '';
  const instruction = mode === 'continue'
    ? 'Continue this document naturally with the next useful section. Do not repeat existing text and do not invent project facts.'
    : mode === 'summary'
      ? 'Summarize this document into a short, useful section with key points, decisions, actions, and open questions only when present.'
      : current
        ? 'Improve this document for clarity, structure, and actionability while preserving the meaning and all supported facts.'
        : 'Draft a useful project document from the title and workspace context. Use clear headings and concise action-oriented content without inventing facts.';
  button.classList.add('ai-working');
  try {
    const result = await aiSuggestion({ fieldName:'doc_content', fieldLabel:'Document content', value:current, instruction, formContext:{ document_title:title } });
    const suggestion = result.suggestion || '';
    if (mode === 'continue' && suggestion) target.value = `${current}${current ? '\n\n' : ''}${suggestion}`;
    else if (mode === 'summary' && suggestion) target.value = `${current}${current ? '\n\n' : ''}## AI Summary\n${suggestion}`;
    else target.value = suggestion || current;
    target.dispatchEvent(new Event('input', { bubbles:true }));
    aiAppliedToast(result, mode === 'summary' ? 'AI summary added' : mode === 'continue' ? 'AI continuation added' : 'AI draft applied');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.classList.remove('ai-working'); }
}

function memberOptionMarkup(selectedId, label = 'Unassigned') {
  return `<option value="">${label}</option>${(state.aiProjectMembers || state.members || []).filter(member => member.status !== 'suspended').map(member => {const ws=workStatusInfo(member);return `<option value="${member.user_id}" ${Number(selectedId)===Number(member.user_id)?'selected':''}>${escapeHtml(ws.emoji)} ${escapeHtml(member.full_name)} · ${escapeHtml(member.department || 'General')} · ${escapeHtml(ws.label)}</option>`}).join('')}`;
}

function decorateAiPlan(plan) {
  const copy = JSON.parse(JSON.stringify(plan || {}));
  const decorateChild = child => ({ ...child, accepted:null, _editing:false, _working:false });
  copy.main_tasks = (copy.main_tasks || []).slice(0, 6).map(main => ({
    ...main,
    accepted:null,
    _editing:false,
    _working:false,
    subtasks:(main.subtasks || []).map(sub => ({
      ...sub,
      accepted:null,
      _editing:false,
      _working:false,
      child_tasks:(sub.child_tasks || []).map(decorateChild)
    }))
  }));
  return copy;
}

function aiReviewState(value) {
  return value === true ? 'accepted' : value === false ? 'rejected' : 'pending';
}

function aiReviewStateLabel(value) {
  return value === true ? '✓ Accepted' : value === false ? '× Rejected' : 'Pending review';
}

function renderAiReviewControls(level, key, value, editing, working = false) {
  return `<div class="ai-review-controls ${working?'ai-item-working':''}">
    <button class="ai-state-btn accept ${value===true?'active':''}" data-ai-${level}-accept="${key}" type="button">✓ Accept</button>
    <button class="ai-state-btn reject ${value===false?'active':''}" data-ai-${level}-reject="${key}" type="button">× Reject</button>
    <button class="ai-state-btn regen" data-ai-${level}-regen="${key}" type="button">↻ Regenerate</button>
    <button class="secondary-btn compact-btn" data-ai-${level}-edit="${key}" type="button">${editing?'Done':'Edit'}</button>
  </div>`;
}

function openAiProjectPlanner(seedBrief = '') {
  state.aiProjectDraft = null;
  state.aiProjectMembers = state.members || [];
  state.aiProjectBrief = String(seedBrief || '');
  state.aiBriefFiles = [];
  $('#aiProjectBrief').value = state.aiProjectBrief;
  renderAiBriefFiles();
  $('#aiProjectBriefStep').classList.remove('hidden');
  $('#aiProjectReviewStep').classList.add('hidden');
  $('#aiBriefActions').classList.remove('hidden');
  $('#aiReviewActions').classList.add('hidden');
  const active = state.members.filter(member => member.status === 'active');
  const eligible = active.filter(member => !AI_UNAVAILABLE_WORK_STATUSES.has(member.status_key || 'free'));
  $('#aiPlannerPeopleHint').innerHTML = `<strong>${eligible.length}/${active.length} workspace ${active.length===1?'person':'people'} currently eligible for automatic AI assignment.</strong>${active.length ? `<span>${active.map(member => {const ws=workStatusInfo(member);return `${escapeHtml(ws.emoji)} ${escapeHtml(member.full_name)} (${escapeHtml(member.department || 'General')} · ${escapeHtml(ws.label)})`}).join(' · ')}</span>` : '<span>Add people to let AI distribute work automatically.</span>'}`;
  $('#aiProjectDialog').showModal();
  setTimeout(()=>$('#aiProjectBrief').focus(),40);
}

async function generateAiProjectPlan(regenerate = false) {
  const brief = regenerate ? state.aiProjectBrief : $('#aiProjectBrief').value.trim();
  if (brief.length < 10) return toast('Add a more complete project brief first.', 'error');
  state.aiProjectBrief = brief;
  const button = regenerate ? $('#regenerateAiProjectBtn') : $('#generateAiProjectBtn');
  setBusy(button, true, regenerate ? 'Regenerating…' : 'Planning…');
  try {
    const payload = await api(`/api/organizations/${state.org.id}/ai-project-plan/preview`, { method:'POST', body:{ brief } });
    state.aiProjectDraft = decorateAiPlan(payload.plan);
    state.aiProjectMembers = payload.members || state.members;
    state.aiProjectDraft._provider = payload.ai_provider;
    state.aiProjectDraft._fallback = Boolean(payload.fallback_used);
    state.aiProjectDraft._warning = payload.warning || '';
    state.aiProjectDraft._projectManager = payload.project_manager || null;
    $('#aiProjectBriefStep').classList.add('hidden');
    $('#aiProjectReviewStep').classList.remove('hidden');
    $('#aiBriefActions').classList.add('hidden');
    $('#aiReviewActions').classList.remove('hidden');
    renderAiProjectReview();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
}

function acceptedAiCounts(plan) {
  const acceptedMain = plan.main_tasks.filter(main => main.accepted === true);
  let direct = 0;
  let nested = 0;
  let pending = 0;
  let rejected = 0;
  for (const main of plan.main_tasks || []) {
    if (main.accepted === null || main.accepted === undefined) pending += 1;
    if (main.accepted === false) rejected += 1;
    for (const sub of main.subtasks || []) {
      if (sub.accepted === null || sub.accepted === undefined) pending += 1;
      if (sub.accepted === false) rejected += 1;
      if (main.accepted === true && sub.accepted === true) direct += 1;
      for (const child of sub.child_tasks || []) {
        if (child.accepted === null || child.accepted === undefined) pending += 1;
        if (child.accepted === false) rejected += 1;
        if (main.accepted === true && sub.accepted === true && child.accepted === true) nested += 1;
      }
    }
  }
  return { acceptedMain, direct, nested, pending, rejected };
}

function renderAiProjectReview() {
  const plan = state.aiProjectDraft; if (!plan) return;
  $('#aiPlanProjectName').value = plan.project_name || '';
  $('#aiPlanProjectSummary').value = plan.project_summary || '';
  const badge = $('#aiPlanProviderBadge');
  badge.textContent = plan._fallback ? 'Local fallback' : `AI · ${plan._provider || 'provider'}`;
  badge.classList.toggle('fallback', Boolean(plan._fallback));
  const counts = acceptedAiCounts(plan);
  const projectManager = plan._projectManager;
  $('#aiPlanReviewStats').innerHTML = `${projectManager?`<span class="project-manager-stat"><b>${escapeHtml(projectManager.full_name)}</b> Project manager · CEO</span>`:''}<span><b>${counts.acceptedMain.length}</b> accepted main</span><span><b>${counts.direct}</b> accepted subtasks</span><span><b>${counts.nested}</b> accepted steps</span><span><b>${counts.pending}</b> pending</span>`;
  $('#aiPlanReviewMount').innerHTML = plan.main_tasks.map((main, mainIndex) => {
    const stateKey = aiReviewState(main.accepted);
    const editing = Boolean(main._editing);
    const directAccepted = (main.subtasks || []).filter(sub=>sub.accepted===true).length;
    const nestedTotal = (main.subtasks || []).reduce((sum,sub)=>sum+(sub.child_tasks||[]).length,0);
    return `<article class="ai-main-task-card ${stateKey}" data-ai-main-card="${mainIndex}">
      <div class="ai-main-task-head">
        <span class="ai-review-state ${stateKey}">${aiReviewStateLabel(main.accepted)}</span>
        <span class="ai-main-number">MAIN ${mainIndex+1}</span>
        <div class="ai-main-title-wrap">${editing?`<input class="ai-plan-inline-title" data-ai-main-field="title" data-main-index="${mainIndex}" value="${escapeHtml(main.title)}">`:`<h4>${escapeHtml(main.title)}</h4>`}</div>
        ${renderAiReviewControls('main',String(mainIndex),main.accepted,editing,main._working)}
      </div>
      <div class="ai-main-meta">
        <label><span>Manager</span><select data-ai-main-field="manager_id" data-main-index="${mainIndex}" ${editing?'':'disabled'}>${memberOptionMarkup(main.manager_id,'Choose manager')}</select></label>
        <label><span>Priority</span><select data-ai-main-field="priority" data-main-index="${mainIndex}" ${editing?'':'disabled'}>${Object.keys(PRIORITY).map(p=>`<option value="${p}" ${main.priority===p?'selected':''}>${PRIORITY[p]}</option>`).join('')}</select></label>
        <label><span>Due date</span><input type="date" data-ai-main-field="due_date" data-main-index="${mainIndex}" value="${escapeHtml(main.due_date||'')}" ${editing?'':'disabled'}></label>
        <label><span>Estimate min</span><input type="number" min="0" data-ai-main-field="estimate_minutes" data-main-index="${mainIndex}" value="${Number(main.estimate_minutes||0)}" ${editing?'':'disabled'}></label>
      </div>
      ${editing?`<textarea class="ai-plan-description" rows="3" data-ai-main-field="description" data-main-index="${mainIndex}">${escapeHtml(main.description||'')}</textarea>`:`<p class="ai-main-description">${escapeHtml(main.description||'')}</p>`}
      <div class="ai-subtasks-block"><div class="ai-subtasks-heading"><strong>Work breakdown</strong><span>${directAccepted}/${main.subtasks.length} accepted subtasks · ${nestedTotal} nested steps</span></div>
        ${main.subtasks.map((sub, subIndex) => renderAiSubtask(mainIndex, subIndex, sub)).join('')}
      </div>
    </article>`;
  }).join('');
}

function renderAiSubtask(mainIndex, subIndex, sub) {
  const stateKey = aiReviewState(sub.accepted);
  const editing = Boolean(sub._editing);
  const children = sub.child_tasks || [];
  const complexity = ['small','medium','heavy'].includes(sub.complexity) ? sub.complexity : (children.length ? 'heavy' : 'medium');
  const key = `${mainIndex}:${subIndex}`;
  return `<div class="ai-subtask-item ${stateKey}">
    <div class="ai-subtask-row">
      <span class="ai-sub-branch">↳</span>
      <div class="ai-sub-content">${editing?`<input data-ai-sub-field="title" data-main-index="${mainIndex}" data-sub-index="${subIndex}" value="${escapeHtml(sub.title)}"><textarea rows="2" data-ai-sub-field="description" data-main-index="${mainIndex}" data-sub-index="${subIndex}">${escapeHtml(sub.description||'')}</textarea>`:`<div class="ai-sub-title-line"><strong>${escapeHtml(sub.title)}</strong><span class="ai-complexity ${complexity}">${complexity}${children.length?` · ${children.length} steps`:''}</span><span class="ai-review-state ${stateKey}">${aiReviewStateLabel(sub.accepted)}</span></div><small>${escapeHtml(sub.description||'')}</small>`}</div>
      <div class="ai-sub-owner"><select data-ai-sub-field="assignee_id" data-main-index="${mainIndex}" data-sub-index="${subIndex}" ${editing?'':'disabled'}>${memberOptionMarkup(sub.assignee_id,'Unassigned')}</select></div>
      <div class="ai-sub-priority"><select data-ai-sub-field="priority" data-main-index="${mainIndex}" data-sub-index="${subIndex}" ${editing?'':'disabled'}>${Object.keys(PRIORITY).map(p=>`<option value="${p}" ${sub.priority===p?'selected':''}>${PRIORITY[p]}</option>`).join('')}</select></div>
      ${renderAiReviewControls('sub',key,sub.accepted,editing,sub._working)}
    </div>
    ${children.length?`<div class="ai-child-task-list">${children.map((child, childIndex)=>renderAiChildTask(mainIndex,subIndex,childIndex,child)).join('')}</div>`:''}
  </div>`;
}

function renderAiChildTask(mainIndex, subIndex, childIndex, child) {
  const stateKey = aiReviewState(child.accepted);
  const editing = Boolean(child._editing);
  const key = `${mainIndex}:${subIndex}:${childIndex}`;
  return `<div class="ai-child-row ${stateKey}">
    <span class="ai-child-branch">↳↳</span>
    <div class="ai-child-content">${editing?`<input data-ai-child-field="title" data-main-index="${mainIndex}" data-sub-index="${subIndex}" data-child-index="${childIndex}" value="${escapeHtml(child.title)}"><textarea rows="2" data-ai-child-field="description" data-main-index="${mainIndex}" data-sub-index="${subIndex}" data-child-index="${childIndex}">${escapeHtml(child.description||'')}</textarea>`:`<strong>${escapeHtml(child.title)}</strong><small>${escapeHtml(child.description||'')}</small><span class="ai-review-state ${stateKey}">${aiReviewStateLabel(child.accepted)}</span>`}</div>
    <div class="ai-child-owner"><select data-ai-child-field="assignee_id" data-main-index="${mainIndex}" data-sub-index="${subIndex}" data-child-index="${childIndex}" ${editing?'':'disabled'}>${memberOptionMarkup(child.assignee_id,'Unassigned')}</select></div>
    <div class="ai-child-priority"><select data-ai-child-field="priority" data-main-index="${mainIndex}" data-sub-index="${subIndex}" data-child-index="${childIndex}" ${editing?'':'disabled'}>${Object.keys(PRIORITY).map(p=>`<option value="${p}" ${child.priority===p?'selected':''}>${PRIORITY[p]}</option>`).join('')}</select></div>
    ${renderAiReviewControls('child',key,child.accepted,editing,child._working)}
  </div>`;
}

function updateAiReviewField(target) {
  const plan = state.aiProjectDraft; if (!plan) return;
  const mainIndex = Number(target.dataset.mainIndex);
  if (target.dataset.aiMainField) {
    const field = target.dataset.aiMainField;
    plan.main_tasks[mainIndex][field] = ['manager_id','estimate_minutes'].includes(field) ? (target.value ? Number(target.value) : null) : target.value;
  }
  if (target.dataset.aiSubField) {
    const subIndex = Number(target.dataset.subIndex);
    const field = target.dataset.aiSubField;
    plan.main_tasks[mainIndex].subtasks[subIndex][field] = ['assignee_id','estimate_minutes'].includes(field) ? (target.value ? Number(target.value) : null) : target.value;
  }
  if (target.dataset.aiChildField) {
    const subIndex = Number(target.dataset.subIndex);
    const childIndex = Number(target.dataset.childIndex);
    const field = target.dataset.aiChildField;
    plan.main_tasks[mainIndex].subtasks[subIndex].child_tasks[childIndex][field] = ['assignee_id','estimate_minutes'].includes(field) ? (target.value ? Number(target.value) : null) : target.value;
  }
}

async function commitAiProjectPlan() {
  const plan = state.aiProjectDraft; if (!plan) return;
  plan.project_name = $('#aiPlanProjectName').value.trim();
  plan.project_summary = $('#aiPlanProjectSummary').value.trim();
  const acceptedMain = plan.main_tasks.filter(main => main.accepted === true);
  if (!acceptedMain.length) return toast('Accept at least one main task first.', 'error');
  const button = $('#commitAiProjectBtn'); setBusy(button, true, 'Creating…');
  try {
    const payload = await api(`/api/organizations/${state.org.id}/ai-project-plan/commit`, { method:'POST', body:{
      brief:state.aiProjectBrief,
      plan,
      space_id:state.globalView === 'space' ? state.activeSpaceId : (state.currentList?.space_id || null),
      folder_id:state.globalView === 'space' ? null : (state.currentList?.folder_id || null)
    }});
    $('#aiProjectDialog').close();
    toast(`AI project created · ${payload.main_task_count} main · ${payload.direct_subtask_count||0} subtasks · ${payload.nested_subtask_count||0} nested steps`);
    await selectOrganization(state.org.id, false);
    await openList(Number(payload.list_id));
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
}


function renderAiBriefFiles() {
  const mount=$('#aiBriefFileList'); if(!mount) return;
  const files=state.aiBriefFiles||[];
  mount.classList.toggle('hidden',!files.length);
  mount.innerHTML=files.map(file=>`<span class="ai-brief-file-chip ${file.status||'loading'}"><span>${file.status==='ok'?'✓':file.status==='error'?'!':'…'}</span><b>${escapeHtml(file.name)}</b>${file.detail?`<span>${escapeHtml(file.detail)}</span>`:''}</span>`).join('');
}

function appendBriefText(name,text) {
  const cleanText=String(text||'').replace(/\u0000/g,'').trim();
  if(!cleanText) throw new Error('No readable text found in this file');
  const textarea=$('#aiProjectBrief');
  const section=`\n\n--- Uploaded file: ${name} ---\n${cleanText}`;
  const next=`${textarea.value||''}${section}`.trim();
  textarea.value=next.slice(0,50000);
  state.aiProjectBrief=textarea.value;
}

function fileToBase64(file) {
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||'').split(',').pop()||'');reader.onerror=()=>reject(new Error('Could not read file'));reader.readAsDataURL(file)});
}

async function extractAiBriefFile(file) {
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  if(file.size>5*1024*1024) throw new Error('File is larger than 5 MB');
  if(['txt','md','markdown','csv','json','rtf'].includes(ext)) {
    let text=await file.text();
    if(ext==='rtf') text=text.replace(/\\'[0-9a-f]{2}/gi,' ').replace(/\\[a-z]+-?\d* ?/gi,' ').replace(/[{}]/g,' ').replace(/\s+/g,' ');
    return text;
  }
  if(!['pdf','docx'].includes(ext)) throw new Error('Supported: PDF, DOCX, MD, TXT, RTF, CSV, JSON');
  const data=await fileToBase64(file);
  const payload=await api(`/api/organizations/${state.org.id}/brief-files/extract`,{method:'POST',body:{name:file.name,mime_type:file.type||'',data}});
  return payload.text||'';
}

async function handleAiBriefFiles(fileList) {
  const files=[...fileList]; if(!files.length) return;
  for(const file of files) {
    const entry={name:file.name,status:'loading',detail:'Reading…'}; state.aiBriefFiles.push(entry); renderAiBriefFiles();
    try { const text=await extractAiBriefFile(file); appendBriefText(file.name,text); entry.status='ok'; entry.detail=`${Math.max(1,Math.round(text.length/1000))}k chars`; }
    catch(error){entry.status='error';entry.detail=error.message;toast(`${file.name}: ${error.message}`,'error')}
    renderAiBriefFiles();
  }
}

async function regenerateAiPlanItem(level,key) {
  if(!state.aiProjectDraft) return;
  const parts=String(key).split(':').map(Number);
  const main=state.aiProjectDraft.main_tasks[parts[0]];
  const item=level==='main'?main:level==='sub'?main.subtasks[parts[1]]:main.subtasks[parts[1]].child_tasks[parts[2]];
  item._working=true; renderAiProjectReview();
  try {
    const payload=await api(`/api/organizations/${state.org.id}/ai-project-plan/regenerate-item`,{method:'POST',body:{brief:state.aiProjectBrief,level,item,parent_main:level!=='main'?main:null,parent_sub:level==='child'?main.subtasks[parts[1]]:null}});
    const replacement=payload.item||{};
    replacement.accepted=null; replacement._editing=false; replacement._working=false;
    if(level==='main') state.aiProjectDraft.main_tasks[parts[0]]=replacement;
    else if(level==='sub') state.aiProjectDraft.main_tasks[parts[0]].subtasks[parts[1]]=replacement;
    else state.aiProjectDraft.main_tasks[parts[0]].subtasks[parts[1]].child_tasks[parts[2]]=replacement;
    if(payload.members) state.aiProjectMembers=payload.members;
    renderAiProjectReview();
    toast(`Regenerated ${level==='main'?'main task':level==='sub'?'subtask':'nested step'}`);
  } catch(error){item._working=false;renderAiProjectReview();toast(error.message,'error')}
}

function setAiPlanAcceptance(value) {
  if (!state.aiProjectDraft) return;
  state.aiProjectDraft.main_tasks.forEach(main => {
    main.accepted = value;
    (main.subtasks || []).forEach(sub => {
      sub.accepted = value;
      (sub.child_tasks || []).forEach(child => { child.accepted = value; });
    });
  });
  renderAiProjectReview();
}

const aiBriefDropzone=$('#aiBriefDropzone');
$('#aiBriefUploadBtn').addEventListener('click',event=>{event.stopPropagation();$('#aiBriefFileInput').click()});
$('#aiBriefFileInput').addEventListener('change',event=>{handleAiBriefFiles(event.target.files);event.target.value=''});
aiBriefDropzone.addEventListener('click',event=>{if(!event.target.closest('button'))$('#aiBriefFileInput').click()});
aiBriefDropzone.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();$('#aiBriefFileInput').click()}});
for(const type of ['dragenter','dragover']) aiBriefDropzone.addEventListener(type,event=>{event.preventDefault();aiBriefDropzone.classList.add('dragging')});
for(const type of ['dragleave','drop']) aiBriefDropzone.addEventListener(type,event=>{event.preventDefault();aiBriefDropzone.classList.remove('dragging')});
aiBriefDropzone.addEventListener('drop',event=>handleAiBriefFiles(event.dataTransfer.files));

$('#closeAiProjectBtn').addEventListener('click',()=>$('#aiProjectDialog').close());
$('#cancelAiProjectBtn').addEventListener('click',()=>$('#aiProjectDialog').close());
$('#generateAiProjectBtn').addEventListener('click',()=>generateAiProjectPlan(false));
$('#regenerateAiProjectBtn').addEventListener('click',()=>generateAiProjectPlan(true));
$('#backAiProjectBtn').addEventListener('click',()=>{state.aiProjectBrief=$('#aiProjectBrief').value||state.aiProjectBrief;$('#aiProjectBrief').value=state.aiProjectBrief;$('#aiProjectReviewStep').classList.add('hidden');$('#aiProjectBriefStep').classList.remove('hidden');$('#aiReviewActions').classList.add('hidden');$('#aiBriefActions').classList.remove('hidden')});
$('#acceptAllAiPlanBtn').addEventListener('click',()=>setAiPlanAcceptance(true));
$('#rejectAllAiPlanBtn').addEventListener('click',()=>setAiPlanAcceptance(false));
$('#commitAiProjectBtn').addEventListener('click',commitAiProjectPlan);
$('#aiPlanProjectName').addEventListener('input',event=>{if(state.aiProjectDraft)state.aiProjectDraft.project_name=event.target.value});
$('#aiPlanProjectSummary').addEventListener('input',event=>{if(state.aiProjectDraft)state.aiProjectDraft.project_summary=event.target.value});
$('#aiPlanReviewMount').addEventListener('click',async event=>{
  const setState = (level,key,value) => {
    const parts=String(key).split(':').map(Number);
    const main=state.aiProjectDraft.main_tasks[parts[0]];
    const item=level==='main'?main:level==='sub'?main.subtasks[parts[1]]:main.subtasks[parts[1]].child_tasks[parts[2]];
    item.accepted=value; renderAiProjectReview();
  };
  for (const level of ['main','sub','child']) {
    const accept=event.target.closest(`[data-ai-${level}-accept]`); if(accept){setState(level,accept.getAttribute(`data-ai-${level}-accept`),true);return}
    const reject=event.target.closest(`[data-ai-${level}-reject]`); if(reject){setState(level,reject.getAttribute(`data-ai-${level}-reject`),false);return}
    const edit=event.target.closest(`[data-ai-${level}-edit]`); if(edit){const parts=edit.getAttribute(`data-ai-${level}-edit`).split(':').map(Number);const main=state.aiProjectDraft.main_tasks[parts[0]];const item=level==='main'?main:level==='sub'?main.subtasks[parts[1]]:main.subtasks[parts[1]].child_tasks[parts[2]];item._editing=!item._editing;renderAiProjectReview();return}
    const regen=event.target.closest(`[data-ai-${level}-regen]`); if(regen){await regenerateAiPlanItem(level,regen.getAttribute(`data-ai-${level}-regen`));return}
  }
});
$('#aiPlanReviewMount').addEventListener('input',event=>updateAiReviewField(event.target));
$('#aiPlanReviewMount').addEventListener('change',event=>updateAiReviewField(event.target));

function openAiDialogWithPrompt(prompt = '') {
  $('#aiResult').classList.add('hidden'); $('#aiResult').textContent=''; $('#aiPrompt').value=prompt;
  $('#aiDialog').showModal(); setTimeout(()=>$('#aiPrompt').focus(),40);
}
$('#aiButton').addEventListener('click',()=>openAiDialogWithPrompt(''));
$('#aiForm').addEventListener('submit',async event=>{event.preventDefault();const prompt=$('#aiPrompt').value.trim();if(!prompt)return;const button=$('#askAiBtn');setBusy(button,true,'Generating…');try{const result=await aiSuggestion({fieldName:'workspace_assistant',fieldLabel:'Workspace assistant',value:'',instruction:prompt,formContext:{workspace:state.org?.name||'Personal',list:state.currentList?.name||''}});$('#aiResult').textContent=`${result.suggestion||'No suggestion generated.'}\n\n${result.fallback?'Local fallback is active. Add your AI API key for generative output.':`Provider: ${result.provider}`}`;$('#aiResult').classList.remove('hidden')}catch(error){toast(error.message,'error')}finally{setBusy(button,false)}});

$('#profileBtn').addEventListener('click',openProfileDialog);
function openProfileDialog(){
  const ws=workStatusInfo(state.presence||{});
  $('#profileContent').innerHTML=`<div class="profile-summary"><div class="profile-big-avatar">${state.me.avatar_url?`<img src="${escapeHtml(state.me.avatar_url)}" alt="">`:escapeHtml(initials(state.me.full_name))}</div><div><h4>${escapeHtml(state.me.full_name)}</h4><p>@${escapeHtml(state.me.username)} · ${escapeHtml(state.me.email)}</p></div></div><div class="profile-status-card"><span class="profile-status-icon">${escapeHtml(ws.emoji)}</span><div class="profile-status-copy"><strong>${escapeHtml(ws.label)}</strong><small>${escapeHtml(ws.note||'Set a work status so teammates and AI know your availability.')}</small></div><button type="button" data-profile-action="status">Change</button></div><div class="profile-menu"><button data-profile-action="picture">◉ Change profile picture</button><button data-profile-action="status">● Set work status</button><button data-profile-action="settings">⚙ Settings</button><button data-profile-action="switch">⇄ Switch Workspace</button><button data-profile-action="logout">↪ Sign out</button></div>`;$('#profileDialog').showModal();
}
$('#profileContent').addEventListener('click',event=>{const a=event.target.closest('[data-profile-action]')?.dataset.profileAction;if(!a)return;$('#profileDialog').close();if(a==='picture'){setGlobalView('settings');setTimeout(()=>$('#avatarFileInput')?.click(),0)}if(a==='status')openStatusDialog();if(a==='settings')setGlobalView('settings');if(a==='switch')openWorkspaceMenu($('#workspaceSwitcherBtn'));if(a==='logout')logout()});

function renderStatusPresets(){
  const key=state.statusDraftKey||'free';
  $('#statusPresetGrid').innerHTML=Object.entries(WORK_STATUS).map(([value,item])=>`<button class="status-preset ${value===key?'active':''}" type="button" data-status-preset="${value}"><span class="status-emoji">${escapeHtml(item.emoji)}</span><span>${escapeHtml(item.label)}</span></button>`).join('');
  $('#customStatusFields').classList.toggle('hidden',key!=='custom');
}
function openStatusDialog(){
  const current=workStatusInfo(state.presence||{});
  state.statusDraftKey=WORK_STATUS[current.key]?current.key:'custom';
  $('#statusNote').value=current.note||'';
  $('#statusExpiry').value='never';
  $('#customStatusEmoji').value=current.key==='custom'?current.emoji:'💬';
  $('#customStatusLabel').value=current.key==='custom'?current.label:'';
  renderStatusPresets();
  $('#statusDialog').showModal();
}
function statusExpiryIso(choice){
  const now=new Date();
  if(choice==='1h')return new Date(now.getTime()+3600000).toISOString();
  if(choice==='4h')return new Date(now.getTime()+14400000).toISOString();
  if(choice==='week')return new Date(now.getTime()+7*86400000).toISOString();
  if(choice==='today'){const end=new Date();end.setHours(23,59,59,999);return end.toISOString()}
  return null;
}
function applyOwnPresence(presence){
  state.presence=presence;
  const index=state.members.findIndex(member=>Number(member.user_id)===Number(state.me?.id));
  if(index>=0)state.members[index]={...state.members[index],...presence};
  updateStatusIndicators();
  if(state.globalView==='people')renderPeople();
}
async function saveWorkStatus(forceFree=false){
  const key=forceFree?'free':(state.statusDraftKey||'free');
  const body={status_key:key,custom_status:forceFree?'':$('#statusNote').value.trim(),status_expires_at:forceFree?null:statusExpiryIso($('#statusExpiry').value)};
  if(key==='custom'){
    body.status_label=$('#customStatusLabel').value.trim();
    body.status_emoji=$('#customStatusEmoji').value.trim()||'💬';
    if(body.status_label.length<2)return toast('Add a custom status message first.','error');
  }
  const button=forceFree?$('#clearStatusBtn'):$('#saveStatusBtn');setBusy(button,true,'Saving…');
  try{const updated=await api('/api/presence/me',{method:'PATCH',body});applyOwnPresence(updated);$('#statusDialog').close();toast(forceFree?'Status cleared to Free':`Status set to ${updated.status_label}`)}
  catch(error){toast(error.message,'error')}
  finally{setBusy(button,false)}
}
$('#statusPresetGrid').addEventListener('click',event=>{const btn=event.target.closest('[data-status-preset]');if(!btn)return;state.statusDraftKey=btn.dataset.statusPreset;renderStatusPresets()});
$('#closeStatusBtn').addEventListener('click',()=>$('#statusDialog').close());
$('#saveStatusBtn').addEventListener('click',()=>saveWorkStatus(false));
$('#clearStatusBtn').addEventListener('click',()=>saveWorkStatus(true));

$('#themeBtn').addEventListener('click',toggleTheme);
async function toggleTheme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';applyTheme(next);try{state.settings=await api('/api/users/me/settings',{method:'PATCH',body:{theme:next}})}catch{}if(state.globalView==='settings')renderSettings()}

$('#mobileSidebarBtn').addEventListener('click',()=>{$('#spacesSidebar').classList.add('mobile-open');$('#mobileBackdrop').classList.remove('hidden')});
$('#mobileBackdrop').addEventListener('click',()=>{$('#spacesSidebar').classList.remove('mobile-open');$('#mobileBackdrop').classList.add('hidden')});
$('#taskDrawerBackdrop').addEventListener('click',closeTaskDrawer);

$('#contentMount').addEventListener('click',async event=>{
  const project=event.target.closest('[data-open-project]');if(project){const listId=Number(project.dataset.listId);if(listId)await openList(listId);return}
  const spaceCard=event.target.closest('[data-open-space]');if(spaceCard){await renderSpaceOverview(Number(spaceCard.dataset.openSpace));return}
  const view=event.target.closest('[data-list-view]');if(view){activateListView(view.dataset.listView,null);return}
  const customView=event.target.closest('[data-custom-view]');if(customView){const item=state.customViews.find(v=>Number(v.id)===Number(customView.dataset.customView));if(item)activateListView(item.view_type,item.id);return}
  const deleteView=event.target.closest('[data-delete-custom-view]');if(deleteView){const id=Number(deleteView.dataset.deleteCustomView);if(confirm('Delete this custom view?')){await api(`/api/list-views/${id}`,{method:'DELETE'});state.customViews=state.customViews.filter(v=>Number(v.id)!==id);if(Number(state.activeCustomViewId)===id){state.activeCustomViewId=null;state.listView='list';localStorage.setItem(`flowmate-list-view-${state.currentList.id}`,'list')}renderListShell();toast('View deleted')}return}
  const open=event.target.closest('[data-open-task]');if(open){const listId=Number(open.dataset.listId||state.currentList?.id);if(listId&&Number(state.currentList?.id)!==listId)state.currentList=findList(listId)||state.currentList;openTaskDrawer(Number(open.dataset.openTask),{listId});return}
  const toggle=event.target.closest('[data-toggle-task]');if(toggle){await toggleTaskComplete(Number(toggle.dataset.toggleTask));return}
  const addStatus=event.target.closest('[data-add-task-status]');if(addStatus){openTaskDrawer(null,{status:addStatus.dataset.addTaskStatus});return}
  const channel=event.target.closest('[data-channel]');if(channel){state.currentChannel=state.channels.find(ch=>Number(ch.id)===Number(channel.dataset.channel));await renderChat();return}
  const doc=event.target.closest('[data-doc]');if(doc){state.selectedDoc=state.docs.find(d=>Number(d.id)===Number(doc.dataset.doc));renderDocs();return}
  const nav=event.target.closest('[data-calendar-nav]');if(nav){if(nav.dataset.calendarNav==='prev')state.calendarDate=new Date(state.calendarDate.getFullYear(),state.calendarDate.getMonth()-1,1);else if(nav.dataset.calendarNav==='next')state.calendarDate=new Date(state.calendarDate.getFullYear(),state.calendarDate.getMonth()+1,1);else state.calendarDate=new Date();renderCurrentListView();return}
  const cell=event.target.closest('[data-calendar-date]');if(cell&&event.target===cell){openTaskDrawer(null,{dueDate:cell.dataset.calendarDate});return}
  const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;
  if(action==='ai-chat-draft'){await applyChatAi(event.target.closest('[data-action]'));return}
  else if(action==='ai-doc-draft'){await applyDocAi('draft',event.target.closest('[data-action]'));return}
  else if(action==='ai-doc-continue'){await applyDocAi('continue',event.target.closest('[data-action]'));return}
  else if(action==='ai-doc-summary'){await applyDocAi('summary',event.target.closest('[data-action]'));return}
  else if(action==='ai-list-plan'){openAiProjectPlanner(state.currentList?.description||'');return}
  else if(action==='ai-project-planner'){if(!state.tree.length){if(state.org?.role==='ceo')openEntityDialog('space');else toast('A CEO must create a Space first.','error');return}openAiProjectPlanner('');return}
  else if(action==='create-space'){if(state.org?.role==='ceo')openEntityDialog('space');else toast('Only the CEO can create Spaces.','error');return}
  else if(action==='add-view'){if(state.currentList)openEntityDialog('view',{listId:state.currentList.id});return}
  else if(action==='new-task')openTaskDrawer();
  else if(action==='new-list'){const s=state.tree[0];if(s)openEntityDialog('list',{spaceId:s.id});else if(state.org?.role==='ceo')openEntityDialog('space');else toast('A CEO must create a Space first.','error')}
  else if(action==='toggle-closed'){state.showClosed=!state.showClosed;renderCurrentListView()}
  else if(action==='new-channel')openEntityDialog('channel');
  else if(action==='new-doc')createDoc();
  else if(action==='save-doc')saveCurrentDoc();
  else if(action==='delete-doc'){if(state.selectedDoc&&confirm('Delete this Doc?')){await api(`/api/docs/${state.selectedDoc.id}`,{method:'DELETE'});state.selectedDoc=null;toast('Doc deleted');renderDocs()}}
  else if(action==='mark-all-read'){await api('/api/users/me/notifications/read-all',{method:'POST',body:{}});renderInbox()}
  else if(action==='invite-people')openEntityDialog('invite');
  else if(action==='toggle-theme')toggleTheme();
  else if(action==='choose-avatar')$('#avatarFileInput')?.click();
  else if(action==='remove-avatar'){if(confirm('Remove your profile picture?'))await saveProfileAvatar('',event.target.closest('[data-action]'));return}
  else if(action==='open-profile')openProfileDialog();
  else if(action==='switch-workspace')openWorkspaceMenu($('#workspaceSwitcherBtn'));
  else if(action==='share-list'){try{await navigator.clipboard.writeText(location.href);toast('Link copied')}catch{toast('Current page link ready to share')}}
  else if(action==='list-menu'&&state.currentList)openTreeMenu('list',state.currentList.id,event.target);
});

$('#contentMount').addEventListener('change', async event => {
  if (event.target.id !== 'avatarFileInput') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await compressAvatarFile(file);
    await saveProfileAvatar(dataUrl);
  } catch (error) { toast(error.message, 'error'); }
});

$('#taskDrawer').addEventListener('click',async event=>{
  const nestedTask=event.target.closest('[data-open-task]');if(nestedTask){await openTaskDrawer(Number(nestedTask.dataset.openTask),{listId:state.currentList?.id});return}
  const aiButton=event.target.closest('[data-ai-task]');if(aiButton){await applyTaskAi(aiButton.dataset.aiTask,aiButton);return}
  const action=event.target.closest('[data-action]')?.dataset.action;if(!action)return;
  if(action==='close-task')closeTaskDrawer();
  else if(action==='add-subtask'){const parentId=state.selectedTaskId;if(parentId)openTaskDrawer(null,{parentTaskId:parentId,listId:state.currentList?.id});return}
  else if(action==='manual-divide'){const parentId=state.selectedTaskId;if(parentId)await openManualBreakdown(parentId);return}
  else if(action==='save-task-divide')await saveTaskFromDrawer({openBreakdown:true});
  else if(action==='save-task')await saveTaskFromDrawer();
  else if(action==='add-comment')addComment();
  else if(action==='toggle-timer')toggleTimer();
  else if(action==='delete-task')deleteSelectedTask();
  else if(action==='copy-task-link'){try{await navigator.clipboard.writeText(`${location.origin}${location.pathname}#task-${state.selectedTaskId}`);toast('Task link copied')}catch{toast('Unable to copy link','error')}}
});
$('#taskDrawer').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.id==='commentInput'){event.preventDefault();addComment()}});

$('#topTimerBtn').addEventListener('click',()=>{if(state.selectedTaskId)toggleTimer();else toast('Open a task to start time tracking.')});

$('#workspaceSwitcherBtn').addEventListener('dblclick',()=>openEntityDialog('workspace'));

function startHeartbeat(){setInterval(()=>{if(state.me)api('/api/presence/heartbeat',{method:'POST',body:{}}).catch(()=>{})},60000)}

document.addEventListener('keydown',event=>{
  const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openCommandDialog();return}
  if(!typing&&state.globalView==='list'){
    if(event.key.toLowerCase()==='l'){state.listView='list';renderListShell()}
    if(event.key.toLowerCase()==='b'){state.listView='board';renderListShell()}
    if(event.key.toLowerCase()==='c'){state.listView='calendar';renderListShell()}
  }
});

$('#closeManualBreakdownBtn').addEventListener('click',()=>$('#manualBreakdownDialog').close());
$('#cancelManualBreakdownBtn').addEventListener('click',()=>$('#manualBreakdownDialog').close());
$('#manualAddSubtaskBtn').addEventListener('click',()=>{state.manualBreakdownDraft.push(blankManualSubtask());renderManualBreakdown()});
$('#saveManualBreakdownBtn').addEventListener('click',saveManualBreakdown);
$('#manualBreakdownRows').addEventListener('input',event=>{
  const subIndex=Number(event.target.dataset.subIndex);
  if(!Number.isInteger(subIndex)||!state.manualBreakdownDraft[subIndex])return;
  const subField=event.target.dataset.manualSubField;
  if(subField){state.manualBreakdownDraft[subIndex][subField]=subField==='estimate_minutes'?Number(event.target.value||0):event.target.value;return}
  const childField=event.target.dataset.manualChildField;
  const childIndex=Number(event.target.dataset.childIndex);
  if(childField&&Number.isInteger(childIndex)&&state.manualBreakdownDraft[subIndex].children?.[childIndex])state.manualBreakdownDraft[subIndex].children[childIndex][childField]=childField==='estimate_minutes'?Number(event.target.value||0):event.target.value;
});
$('#manualBreakdownRows').addEventListener('change',event=>event.target.dispatchEvent(new Event('input',{bubbles:true})));
$('#manualBreakdownRows').addEventListener('click',event=>{
  const removeSub=event.target.closest('[data-manual-remove-sub]');
  if(removeSub){state.manualBreakdownDraft.splice(Number(removeSub.dataset.manualRemoveSub),1);if(!state.manualBreakdownDraft.length)state.manualBreakdownDraft.push(blankManualSubtask());renderManualBreakdown();return}
  const addChild=event.target.closest('[data-manual-add-child]');
  if(addChild){const index=Number(addChild.dataset.manualAddChild);state.manualBreakdownDraft[index].children.push(blankManualChild());renderManualBreakdown();return}
  const removeChild=event.target.closest('[data-manual-remove-child]');
  if(removeChild){const [subIndex,childIndex]=removeChild.dataset.manualRemoveChild.split(':').map(Number);state.manualBreakdownDraft[subIndex].children.splice(childIndex,1);renderManualBreakdown()}
});

window.addEventListener('online',()=>toast('Back online'));
window.addEventListener('offline',()=>toast('You are offline','error'));

boot();
