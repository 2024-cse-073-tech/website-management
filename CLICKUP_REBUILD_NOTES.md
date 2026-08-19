# FlowMate v3.0 Rebuild Notes

## Rebuilt frontend
- New ClickUp-inspired application shell with top navigation, global rail, Spaces sidebar, and view header.
- Workspace Home, List, Board, Calendar, Dashboard, All Tasks, My Tasks, Docs, Chat, Inbox, People, and Settings surfaces.
- Task drawer supports editing, comments, time tracking, priority, assignee, dates, and estimates.
- Board drag-and-drop updates task status through the backend.
- `Ctrl+K` workspace search and an AI assistant dialog are integrated.
- Responsive navigation and light/dark themes are included.

## Extended backend
- Added Spaces, Folders, task Lists, Docs, task comments, and time-entry persistence.
- Added List-scoped and organization-wide task APIs.
- Added hierarchy APIs and workspace dashboard aggregation.
- Extended task schema with list, parent, start date, estimate, ordering, and archive fields.
- Preserved legacy project/task compatibility, secure authentication, organizations/members, channels, notifications, AI, Turso, and SQLite.

## Verification
- Automated regression suite passes after the redesign.
- Manual end-to-end API verification covers registration, Workspace creation, hierarchy generation, Folder/List creation, task create/update, comments, timer start/stop, Docs, dashboard aggregation, and persisted fetches.

## Scope boundary
This is an independent FlowMate implementation based on observable ClickUp workflows. ClickUp's private server code, database schema, proprietary APIs, and internal source are not accessible from a shared app URL and are not copied into this project.
