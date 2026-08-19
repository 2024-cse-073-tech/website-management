# Requirements Traceability

| Requirement | Implementation |
|---|---|
| Work like Slack | Organization workspaces, channels, messages, workspace switcher, member identities |
| CEO creates organization | `POST /api/organizations` creates organization and CEO membership |
| CEO gives admin/moderator access | Invitation role rules and membership update API |
| Every user creates an ID | Registration requires unique username and email |
| Managers use username/email credentials | Invitation API resolves exact registered username or email |
| Invitation still requires approval | Invitation states `invited` → `awaiting_approval` → `approved` |
| CEO/admin approval required | Only CEO/admin can call invitation approval endpoint |
| Admin dashboard handles all members | Full membership list, role/status controls, removal, invitation approvals/history |
| Replace Python with JavaScript | All runtime code is under `src/*.js` and `public/app.js`; no Python runtime remains |
| Preserve project assistant | Organization-scoped project, task, plan, meeting, risk, change, report, audit, and export APIs |
| Human approval of AI work | AI plans and extracted suggestions are stored as pending until authorized review |
| Test critical access flow | `tests/workspace.test.js` verifies the two-step joining workflow and role permissions |
| Organization creation optional after sign-up | Registration creates only the user account; onboarding offers Create, Join, or Do This Later |
| No-organization onboarding gate | `/api/auth/me` returns `workspace_access`; frontend shows onboarding and clears workspace selections while no active membership exists |
| Workspace unlock after membership | Workspace shell loads only when `can_access_workspace` is true and an active organization membership is present |
| Member directory | Dedicated People view lists all members with avatar, role, department, membership state, presence, custom status, and last active time |
| Role management | CEO/admin membership controls enforce role hierarchy and protect the CEO membership |
| Departments | Organization-specific `memberships.department` plus `invitations.proposed_department` |
| Organization switching | Desktop sidebar and mobile top-bar selectors; in-workspace organization creation switches immediately |
| Invitations | Department-aware two-step invitation flow, history, approval/rejection, and permission-aware cancellation |
| Slack-style presence | `user_presence` table, heartbeat endpoint, automatic online/away/offline calculation, manual modes, and presence dots |
| Member avatars | Initial-based avatars with optional HTTPS profile image URL |
| Profile | Dedicated Profile view and `/api/users/me/profile` for name/avatar plus workspace-status controls |
| Settings | Dedicated Settings view and persisted `user_settings` record |
| Notifications | Private notification list, unread count, read/read-all actions, preferences, invitation/access/@mention events |
| Account activity | Private chronological `account_activity` history for account, access, profile, settings, and status events |
| Light/Dark themes | Direct top-bar toggle, server-persisted preference, local startup cache, and dark CSS tokens |
| Workspace statuses | Preset/custom emoji statuses in `user_presence`, displayed beside names in channels, People, admin, tasks, Kanban, and sidebar |
| Responsive enterprise UX | Mobile navigation drawer, responsive layouts, touch targets, adaptive forms/dialogs/chat, and print-safe styling |
| Accessibility | Semantic tabs/navigation, skip link, visible keyboard focus, focus-trapped dialogs, ARIA live/busy states, forced-colors and reduced-motion support |
| Loading and error states | Global loading indicator, button busy states, request timeouts, offline banner, retryable workspace errors, and standardized API errors with request IDs |
| Session security | HttpOnly SameSite cookies, server-side session registry, current/other-device revocation, logout invalidation, and same-origin checks for cookie mutations |
| Application security | CSP and related browser headers, body/content-type limits, authentication/API throttling, password policy, production secret validation, and safer static caching |
| Deployment readiness | Liveness/readiness endpoints, graceful shutdown, environment configuration, Dockerfile, Compose setup, local SQLite fallback, full Turso production persistence, and production startup command |
