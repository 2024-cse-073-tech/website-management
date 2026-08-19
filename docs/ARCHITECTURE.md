# Architecture

## Runtime layers

1. **Browser client**
   - Plain HTML, CSS, and JavaScript with no runtime framework dependency.
   - Uses an HttpOnly, SameSite=Strict browser session cookie; legacy bearer tokens remain accepted for API clients and safe upgrades.
   - Provides authentication, profiles, settings, themes, notifications, account activity, active sessions, channels, project views, and administration.
   - Includes request timeouts, loading/error recovery, offline feedback, accessible dialogs, and responsive mobile navigation.

2. **Node.js HTTP application**
   - Uses the built-in `node:http` server and explicit REST routes.
   - Validates input, authenticates sessions, checks same-origin cookie mutations, rate-limits requests, and enforces organization roles.
   - Applies consistent security headers and request IDs to API and static responses.
   - Exposes liveness/readiness endpoints and handles graceful shutdown.

3. **Authorization model**
   - User account and server-side session must both be active.
   - Every organization operation checks an active membership.
   - CEO/admin/moderator/member permissions are evaluated per action.
   - Project and channel access is inherited from the parent organization.

4. **SQLite/Turso persistence**
   - Local development uses Node.js `node:sqlite` with foreign-key constraints, WAL mode, busy timeout, and prepared statements.
   - When Turso variables are configured, the same full workspace schema and data access layer run against remote libSQL through `@libsql/client`.
   - Stores users, revocable authentication sessions, organizations, memberships, invitations, presence/status, settings, notifications, account activity, channels, messages, projects, project records, and audit history.

5. **Local AI engine**
   - Implemented in JavaScript.
   - Generates unapproved work plans.
   - Extracts explicit tasks, decisions, and risks from meeting notes.
   - Detects evidence-based project risks.
   - Calculates likely change impacts.

6. **User experience services**
   - Theme preference supports direct Light and Dark modes.
   - Workspace status is descriptive and separate from heartbeat-derived live presence.
   - Notifications and account activity are private per user.
   - Active-session controls allow users to revoke current or other devices.

## Authentication and session flow

```text
register / sign in
      |
      v
signed HMAC token + HttpOnly SameSite cookie
      |
      v
server-side auth_sessions record
      |
      +---- active and unexpired ----> authorized request
      |
      +---- revoked / expired -------> 401
```

Passwords use versioned scrypt hashes. Older hashes created by previous iterations are verified for compatibility and are replaced naturally when accounts are recreated or password-change support is introduced.

## Membership state flow

```text
registered user
      |
      v
invited ---------> declined/rejected
      |
      | user accepts
      v
awaiting_approval
      |
      | CEO/admin approves
      v
active membership
```

The `awaiting_approval` state is intentionally not a membership. Organization data remains inaccessible until approval creates or activates a membership record.

## Security decisions

- Passwords use scrypt with a unique random salt and explicit algorithm parameters.
- Authentication tokens are HMAC-SHA256 signed, expire, and are linked to revocable database sessions.
- Cookie-authenticated mutations reject cross-site requests.
- SQL values use prepared statements and foreign-key constraints.
- Request bodies are size-limited and JSON media types are validated.
- Authentication and general API requests have separate rate limits.
- CSP, anti-framing, MIME-sniffing, referrer, permissions, and cross-origin policies are applied consistently.
- Static paths are resolved inside the public directory and use ETags.
- Production startup fails closed without a sufficiently long `TOKEN_SECRET`.
- CEO membership cannot be removed or modified through the ordinary membership API.
- Only the CEO can grant or modify admin access.
