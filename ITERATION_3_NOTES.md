# Iteration 3 — User Experience Enhancements

## Delivered

- Dedicated **Profile** page for full name, avatar, organization role/department context, and workspace status.
- Dedicated **Settings** page with Light and Dark themes plus persisted notification and presence preferences.
- Dedicated **Notifications** page with unread counts, per-item read state, mark-all-read, and contextual navigation.
- Dedicated **Account activity** page recording account creation, sign-ins, profile/settings/status changes, invitations, and membership events.
- Workspace status presets: 🟢 Available, 🔴 Busy, 🏖️ On Leave, 🏠 Remote, 🟡 In a Meeting, 🎯 Focus Time, ✈️ Travelling, and custom emoji/label.
- Status badges shown beside names in the sidebar, channels, People directory, admin member table, Kanban cards, and work breakdown ownership.
- Existing live presence remains separate from descriptive workspace status and continues to support automatic heartbeat, Online, Away, Do not disturb, and Offline.
- Invitation, approval, rejection, membership, and @mention notifications with user-level notification preferences.
- Safe SQLite migration from Iteration 2 databases.

## Theme behaviour

- **Light** always uses the light interface.
- **Dark** always uses the dark interface.
- A quick theme button switches directly between Light and Dark and saves the preference.
- Theme preference is stored server-side and cached locally to avoid a flash of the wrong theme during startup.

## Privacy and access

- Notifications and account activity are private to the signed-in user.
- Organization member status is visible only to active members of the same organization.
- Notification preferences can disable workspace, mention, invitation, or account-activity alerts independently.
