'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

test('fresh frontend has real authentication and no bundled demo identity', () => {
  assert.match(htmlSource, /id="signInForm"/);
  assert.match(htmlSource, /id="signUpForm"/);
  assert.match(htmlSource, /id="resetForm"/);
  assert.match(appSource, /\/api\/auth\/login/);
  assert.match(appSource, /\/api\/auth\/register/);
  assert.match(appSource, /\/api\/auth\/forgot-password/);
  assert.match(appSource, /\/api\/auth\/reset-password/);
  assert.doesNotMatch(htmlSource, /Demo:|Ayesha Khan|Acme Workspace|Password123!/i);
});


test('v3.1 auth onboarding and contextual AI flows are exposed in the frontend', () => {
  assert.match(htmlSource, /auth-card-centered/);
  assert.match(htmlSource, /minlength="8"/);
  assert.match(htmlSource, /id="forgotBtn"/);
  assert.match(htmlSource, /id="chooseCreateWorkspace"/);
  assert.match(htmlSource, /id="chooseJoinWorkspace"/);
  assert.match(htmlSource, /id="continuePersonalBtn"/);
  assert.match(appSource, /\/api\/personal-workspace/);
  assert.match(appSource, /\/api\/invitations\/join/);
  assert.match(appSource, /data-ai-task/);
  assert.match(appSource, /ai-doc-draft/);
  assert.match(appSource, /ai-doc-continue/);
  assert.match(appSource, /ai-doc-summary/);
  assert.match(appSource, /ai-list-plan/);
  assert.match(appSource, /ai-chat-draft/);
});


test('v3.2 AI project planner turns a brief into reviewable managers, main tasks and subtasks', () => {
  assert.match(htmlSource, /id="aiProjectDialog"/);
  assert.match(htmlSource, /Project Brief → Full Plan/);
  assert.match(appSource, /ai-project-plan\/preview/);
  assert.match(appSource, /ai-project-plan\/commit/);
  assert.match(appSource, /function openAiProjectPlanner/);
  assert.match(appSource, /data-ai-main-toggle/);
  assert.match(appSource, /data-ai-sub-toggle/);
  assert.match(appSource, /data-ai-main-edit/);
  assert.match(appSource, /data-ai-sub-edit/);
  assert.match(appSource, /add-subtask/);
  assert.match(cssSource, /\.ai-main-task-card/);
  assert.match(cssSource, /\.subtask-row/);
});

test('workspace shell exposes ClickUp-style global rail, Spaces sidebar and command bar', () => {
  assert.match(htmlSource, /class="global-topbar"/);
  assert.match(htmlSource, /class="global-rail"/);
  assert.match(htmlSource, /id="spacesSidebar"/);
  assert.match(htmlSource, /id="spacesTree"/);
  assert.match(htmlSource, /id="commandSearchBtn"/);
  assert.match(htmlSource, /data-global="home"/);
  assert.match(htmlSource, /data-global="inbox"/);
  assert.match(htmlSource, /data-global="chat"/);
  assert.match(htmlSource, /data-global="docs"/);
  assert.match(htmlSource, /data-global="dashboard"/);
  assert.match(appSource, /workspace-tree/);
  assert.match(appSource, /function renderSidebar\(/);
  assert.match(appSource, /function openWorkspaceMenu\(/);
});

test('list work supports List, Board, Calendar and Dashboard views', () => {
  assert.match(appSource, /function renderListView\(/);
  assert.match(appSource, /function renderBoardView\(/);
  assert.match(appSource, /function renderCalendarView\(/);
  assert.match(appSource, /function renderListDashboard\(/);
  assert.match(appSource, /data-drop-status/);
  assert.match(appSource, /data-calendar-date/);
  assert.match(appSource, /Group: Status/);
  assert.match(appSource, /Assignee/);
  assert.match(appSource, /Show closed|Closed/);
});

test('task drawer persists task properties, comments and time tracking', () => {
  assert.match(htmlSource, /id="taskDrawer"/);
  assert.match(appSource, /function openTaskDrawer\(/);
  assert.match(appSource, /\/api\/lists\/\$\{state\.currentList\.id\}\/tasks/);
  assert.match(appSource, /\/api\/tasks\/\$\{state\.selectedTaskId\}\/comments/);
  assert.match(appSource, /\/api\/tasks\/\$\{state\.selectedTaskId\}\/time/);
  assert.match(appSource, /estimate_minutes/);
  assert.match(appSource, /start_date/);
  assert.match(appSource, /due_date/);
});

test('Docs, Chat, Inbox, People and Settings are functional views', () => {
  assert.match(appSource, /function renderDocs\(/);
  assert.match(appSource, /function renderChat\(/);
  assert.match(appSource, /function renderInbox\(/);
  assert.match(appSource, /function renderPeople\(/);
  assert.match(appSource, /function renderSettings\(/);
  assert.match(appSource, /\/api\/organizations\/\$\{state\.org\.id\}\/docs/);
  assert.match(appSource, /\/api\/channels\/\$\{state\.currentChannel\.id\}\/messages/);
  assert.match(appSource, /\/api\/users\/me\/notifications/);
  assert.match(appSource, /\/api\/organizations\/\$\{id\}\/members/);
});

test('AI and global search are exposed without leaking keys to the browser', () => {
  assert.match(htmlSource, /id="aiDialog"/);
  assert.match(htmlSource, /id="commandDialog"/);
  assert.match(appSource, /\/api\/ai\/suggest/);
  assert.match(htmlSource, /Ctrl K/);
  assert.doesNotMatch(appSource, /GEMINI_API_KEY|OPENAI_API_KEY|TURSO_AUTH_TOKEN/);
});

test('theme initialization remains CSP compatible and client requests use same-origin credentials', () => {
  assert.match(htmlSource, /<script src="\/theme-init\.js"><\/script>/);
  assert.doesNotMatch(htmlSource, /<script>\s*\(\(\) =>/);
  assert.match(appSource, /credentials: 'same-origin'/);
  assert.match(appSource, /function toggleTheme\(/);
  assert.match(cssSource, /html\[data-theme="dark"\]/);
});

test('responsive workspace supports mobile navigation and task drawer', () => {
  assert.match(htmlSource, /id="mobileSidebarBtn"/);
  assert.match(htmlSource, /id="mobileBackdrop"/);
  assert.match(cssSource, /@media\(max-width:820px\)/);
  assert.match(cssSource, /\.spaces-sidebar\.mobile-open/);
  assert.match(cssSource, /\.task-drawer/);
});

test('v3.2.2 centers auth in the full viewport and exposes nested AI subdivision', () => {
  assert.match(cssSource, /\.auth-screen\{[\s\S]*grid-template-columns:1fr!important/);
  assert.match(cssSource, /\.auth-center-wrap\{[\s\S]*justify-content:center/);
  assert.match(cssSource, /\.auth-tabs\{justify-content:center!important/);
  assert.match(htmlSource, /6 main workstreams/);
  assert.match(appSource, /data-ai-child-toggle/);
  assert.match(appSource, /data-ai-child-edit/);
  assert.match(appSource, /function renderAiChildTask/);
  assert.match(appSource, /nested steps/);
  assert.match(cssSource, /\.ai-child-row/);
  assert.match(cssSource, /\.nested-task-badge/);
});


test('v3.4.2 settings supports uploaded and removable profile pictures', () => {
  assert.match(appSource, /id=\"avatarFileInput\"/);
  assert.match(appSource, /data-action=\"choose-avatar\"/);
  assert.match(appSource, /data-action=\"remove-avatar\"/);
  assert.match(appSource, /function compressAvatarFile\(/);
  assert.match(appSource, /\/api\/users\/me\/profile/);
  assert.match(cssSource, /\.settings-avatar-preview/);
  assert.match(cssSource, /\.message-avatar img/);
});

test('v3.5 exposes persistent project switching and functional custom +View flow', () => {
  assert.match(htmlSource, /id="projectsTree"/);
  assert.match(appSource, /function renderProjectsSidebar\(/);
  assert.match(appSource, /data-project-list/);
  assert.match(appSource, /\/api\/organizations\/\$\{id\}\/projects/);
  assert.match(appSource, /action==='add-view'/);
  assert.match(appSource, /\/api\/lists\/\$\{state\.currentList\.id\}\/views/);
  assert.match(appSource, /data-custom-view/);
  assert.match(appSource, /data-delete-custom-view/);
  assert.match(cssSource, /\.project-nav-item/);
  assert.match(cssSource, /\.custom-view-wrap/);
});


test('v3.5.3 uses first-and-last initials and full-name home greeting', () => {
  assert.match(appSource, /const last = parts\.length > 1 \? \(parts\[parts\.length - 1\]/);
  assert.match(appSource, /return `\$\{first\}\$\{last\}`\.toUpperCase\(\)/);
  assert.match(appSource, /function displayName\(user\)/);
  assert.match(appSource, /Good \$\{dayPart\(\)\}, \$\{escapeHtml\(displayName\(state\.me\)\)\}/);
  assert.doesNotMatch(appSource, /split\(' '\)\[0\]/);
});


test('v3.6.2 authentication exposes password visibility controls and local reset-code UI', () => {
  assert.match(htmlSource, /data-password-toggle/);
  assert.match(htmlSource, /id="resetCodeNotice"/);
  assert.match(htmlSource, /id="resetCodeValue"/);
  assert.match(htmlSource, /id="resetCodeInput"/);
  assert.match(appSource, /result\.dev_reset_code/);
  assert.match(appSource, /input\.type = reveal \? 'text' : 'password'/);
  assert.match(cssSource, /\.password-input-wrap/);
  assert.match(cssSource, /\.reset-code-notice/);
});
