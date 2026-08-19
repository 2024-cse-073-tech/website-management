
## v3.6.0 AI Planner review upgrades

- Project briefs can be pasted or assembled from uploaded PDF, DOCX, Markdown, TXT, RTF, CSV, and JSON files.
- AI-generated main tasks, subtasks, and nested steps start in **Pending review** instead of being auto-accepted.
- Every level has independent Accept, Reject, Edit, and Regenerate controls.
- Accept all / Reject all remain explicit bulk actions. Only items explicitly accepted are committed to the project.
- Planner review scrolling is contained inside the modal with a fixed action footer.
- PDF and DOCX extraction is server-side; files are used for text extraction and are not persisted as attachments.

# FlowMate v3.4.0 — AI Assignment + Slack-style Status Workspace

FlowMate is a full-stack, independently implemented project-management workspace inspired by the current ClickUp information architecture and interaction patterns. It keeps the existing secure Node.js backend and persistence layer, while rebuilding the browser UI around **Workspace → Spaces → Folders → Lists → Tasks**.

This project does **not** contain or depend on ClickUp proprietary source code or private APIs. It recreates the observable project-management workflows with its own implementation and FlowMate branding.

## What is included

### Workspace hierarchy
- Multiple organizations/workspaces
- Spaces
- Folders inside Spaces
- Lists inside Spaces or Folders
- Tasks scoped to Lists while retaining compatibility with the legacy project model
- Workspace member roles and invitations


### AI-first project planning (v3.4.0)
- Project brief → AI-generated review plan
- 6 main workstreams for normal non-trivial project briefs (hard maximum: 6)
- Diverse manager assignment from available workspace people, plus balanced executor assignment across the full available team
- 7–12 detailed subtasks per main workstream when the scope supports it
- Heavy subtasks can be divided again into nested execution steps
- Accept / reject / edit at main-task, subtask, and nested-step levels
- Accepted hierarchy persists as real parent/child task records
- Groq GPT-OSS 120B is the default external provider when `GROQ_API_KEY` is configured

### AI ownership & Slack-style work status (v3.4.0)
- Workspace CEO is persisted as the project-level manager by default
- AI chooses separate workstream managers for the six main tasks when suitable team members exist
- Every direct subtask and nested child task is pre-assigned before review whenever an eligible team member exists
- Backend repairs null/invalid AI assignments and balances generated execution work across eligible people
- On Leave, Do Not Disturb, and Travelling members are avoided for automatic assignment; Busy/Meeting/Focus are lower preference
- Review screen still allows manager and assignee edits before project creation
- Slack-style personal work statuses: Free, Busy, On Work, Work From Home, On Leave, DND, Meeting, Focus, Travelling, and Custom
- Optional status note and expiry; expired statuses automatically clear back to Free
- Work status is visible in People, profile, top-avatar indicator, and AI assignment dropdowns

### Task workspace
- List view
- Board/Kanban view with drag-and-drop status changes
- Calendar view
- Per-List dashboard
- All Tasks and My Tasks
- Task drawer with title, description, status, assignee, priority, start date, due date, and estimate
- Task comments/activity
- Start/stop time tracking
- Task delete and archive-ready schema

### Productivity areas
- Workspace Home
- Global Dashboards
- Docs with create/edit/save/delete
- Team Chat with channels, immediate sender rendering, same-channel Server-Sent Events (SSE) live updates, and polling fallback
- Inbox / notifications
- People directory
- Search / command dialog (`Ctrl+K`)
- Quick create menu
- Light and dark themes with pre-CSS local preference restore to avoid refresh flicker
- Responsive/mobile navigation
- AI assistant through the existing server-side AI endpoint

### Backend and persistence
- Node.js HTTP API
- Secure session-cookie authentication
- Password recovery support through SMTP when configured
- Included initialized local SQLite database for development (`data/project_assistant_js.db`)
- Turso/libSQL support for persistent production storage
- Organization-scoped access checks
- Audit/event infrastructure retained from the previous project
- Database migrations for Spaces, Folders, Lists, Docs, comments, time entries, and extended task fields

## Requirements

- Node.js **22.5+**
- npm

`node:sqlite` can show an experimental warning on some Node.js 22 releases. That warning does not prevent the app from running.

## Run locally

```bash
npm install
npm start
```

Then open:

```text
http://127.0.0.1:8000
```

Create a real account, then choose team workspace, invite/join flow, or personal mode. Authentication is centered in the full viewport. A default Team Space is created when a workspace is initialized, but no sample project is created. Only projects you explicitly create or commit from an AI client brief appear in Projects.

## Environment configuration

Copy `.env.example` values into your deployment environment. Important production variables include:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=8000
TOKEN_SECRET=<long-random-secret>
TURSO_DATABASE_URL=<your-turso-url>
TURSO_AUTH_TOKEN=<your-turso-token>
```

For free-friendly AI testing, set `GROQ_API_KEY` in `.env`; the key stays server-side. The AI planner targets six main workstreams, 7–12 direct subtasks per workstream when appropriate, nested steps for heavy work, and balanced assignments across available team members. SMTP variables are only required for email password recovery.

For Render + Turso deployment, use:
- `DATABASE_SETUP_STEP_BY_STEP.md`
- `RENDER_REDEPLOY_GUIDE.md`

## Data storage

When Turso variables are configured, the application uses Turso/libSQL. Without them, it uses the included local SQLite database under `data/`. Local SQLite persists across local app restarts on the same machine, but should not be relied on for durable persistence on ephemeral free hosting such as Render Free.


## v3.3 real-time + manual breakdown upgrades

- `data/project_assistant_js.db` ships initialized with the full schema; `npm run db:init` can safely initialize/re-check the local schema.
- Channel messages render immediately for the sender from the POST response and are pushed to other users in the same channel through an authenticated SSE endpoint. A periodic GET sync remains as a fallback.
- Theme bootstrap and runtime now use the same `flowmate-theme` storage key, so a saved dark/light preference is applied before CSS paints and does not jump after refresh.
- AI project planning targets six main workstreams, deeper direct subtasks, nested steps for heavy work, diversified managers, and team coverage across available members when enough work exists.
- Manual tasks support **Create & divide**. An existing task also has **Manual divide**, where the user can add multiple subtasks, assign different people, and add nested execution steps before committing the breakdown.

## Tests

```bash
npm test
```

The regression suite covers authentication/security, workspace roles, persistence behavior, AI integration behavior, and the rebuilt frontend's main ClickUp-style surfaces.

## Main files

```text
public/index.html       Application shell and dialogs
public/styles.css       Rebuilt responsive application UI
public/app.js           Browser SPA behavior and API integration
src/server.js           HTTP API and workspace routes
src/db.js               SQLite/Turso schema + migrations
src/auth.js             Authentication/session security
src/aiProvider.js       External/local AI provider adapter
```

## Production note

FlowMate v3.0 aims at a working ClickUp-style core workflow, not exhaustive parity with every ClickUp enterprise/paid feature. Advanced areas such as Whiteboards, Gantt, external integrations, automations marketplace, clips/video, and every ClickUp settings screen are outside this build unless added separately.

## v3.1 onboarding, invites, and contextual AI

FlowMate v3.1 removes the forced-team-workspace onboarding flow. After registration a user can:

- Create a team workspace.
- Join an existing workspace from an account invitation or a shareable invitation link.
- Continue in Personal mode without creating a team organization. Internally, Personal mode uses an isolated `workspace_type=personal` container so the existing task, Docs, Chat, and persistence APIs remain consistent; the UI presents it as `Personal / Just you`.

Authentication now accepts passwords of 8 or more characters while still requiring uppercase, lowercase, and a number. Forgot Password / reset-password remains available from the centered sign-in card.

Workspace invitations can target an existing username or email. An email address that has not registered yet can receive a shareable link and join after creating an account with that email. Invite tokens are stored as SHA-256 hashes and expire after seven days. Set `APP_BASE_URL` in production so emailed links point at the deployed app.

Contextual AI actions are available in Lists, Tasks, Docs, and Chat in addition to the global AI assistant. AI requests are made server-side through `/api/ai/suggest`; provider keys are never embedded in `public/app.js`.

### AI environment examples

Groq (default):

```env
ALLOW_EXTERNAL_AI=true
AI_PROVIDER=groq
GROQ_API_KEY=your_private_key
AI_PROVIDER_URL=https://api.groq.com/openai/v1
AI_MODEL=openai/gpt-oss-120b
```

Gemini alternative:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
AI_MODEL=gemini-3.6-flash
```

FlowMate accepts `GROQ_API_KEY` directly. `AI_PROVIDER_API_KEY` remains available for other OpenAI-compatible providers.

For deployed invite links also set:

```env
APP_BASE_URL=https://your-app.example.com
```

## v3.2 AI Project Brief Planner

The primary AI planning flow can now start from a project brief instead of requiring the user to manually break work down first.

- Open **Plan project with AI** from Home, `+ New`, command search, or a List header.
- Paste the project brief.
- The server-side AI receives the brief plus active workspace people, including department, role, current status, active workload count, and capacity.
- AI proposes project name/summary, main tasks, a manager for each main task, and related subtasks with assignees.
- The plan is a preview only. Users can accept/reject individual main tasks and subtasks, edit assignments/content, Accept all, Reject all, or Regenerate.
- **Create accepted plan** persists only accepted work as real parent/child tasks.
- Manual task creation remains available and existing tasks now support **Add subtask**.

When an external AI key is configured, the configured provider generates the plan. Without a configured provider, FlowMate visibly uses its local fallback rather than exposing or inventing a browser-side key.


## Profile pictures (v3.5.0)
Settings → Preferences lets each user upload or remove a profile picture. Images are resized in the browser and persist in SQLite/Turso with the user profile.
