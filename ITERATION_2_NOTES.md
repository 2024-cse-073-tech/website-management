# Iteration 2 — Organization & Member Features

## Delivered

- People directory with avatar, role, department, membership status, presence, custom status, email, and last active time.
- Role and department administration for CEO/admin with existing role hierarchy protections.
- Department-aware two-step invitations and invitation cancellation.
- Multi-organization switching plus in-workspace organization creation.
- Slack-style presence with automatic heartbeat and manual Online, Away, Do not disturb, or Offline modes.
- User profile editor for full name, optional HTTPS avatar URL, and custom presence status.
- Safe SQLite migrations for databases created by Iteration 1.
- Responsive member cards and administration tables.

## Presence rules

- Active heartbeat within 2 minutes: Online.
- No heartbeat for 2–15 minutes: Away.
- No heartbeat for more than 15 minutes: Offline.
- Manual Away, Do not disturb, or Offline overrides automatic detection.

## Authorization

- All active members can view the People directory.
- CEO can manage admin, moderator, and member roles.
- Admin can manage moderator and member roles.
- Moderator can invite/cancel member invitations but cannot approve access or modify roles.
- CEO membership remains protected from removal or role changes.
