# Iteration 4 – Production Quality Polish

Version: 2.5.0

## User experience

- Responsive mobile navigation drawer with keyboard and backdrop controls.
- Accessible skip link, tab semantics, visible keyboard focus, reduced-motion support, ARIA busy/live states, and focus-trapped dialogs.
- Global request progress, button-level loading states, workspace loading screens, recoverable error screens, request references, and offline/online feedback.
- Improved touch targets, responsive top bar/forms/tables/chat, print handling, and active-session management in Settings.

## Security

- HttpOnly, SameSite=Strict session cookies while retaining bearer-token API compatibility.
- Server-side revocable sessions with current-device and other-device sign-out controls.
- Stronger password validation and versioned scrypt hashes with legacy-hash compatibility.
- Same-origin protection for cookie-authenticated mutations.
- API and authentication rate limits, body-size limits, media-type validation, request timeouts, method handling, and request IDs.
- CSP, anti-framing, MIME-sniffing, referrer, permissions, cross-origin isolation, and optional HSTS headers.
- Production fails closed when `TOKEN_SECRET` is missing or too short.

## Deployment readiness

- Liveness and readiness endpoints.
- Graceful SIGTERM/SIGINT shutdown and hardened Node server timeouts.
- Dockerfile, Docker Compose configuration, persistent SQLite volume, health check, and production environment template.
- Fresh database package with no demo users, organizations, projects, messages, or tasks.
