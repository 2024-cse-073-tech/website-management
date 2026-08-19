# Privacy, Security, and Limitations

- Browser sessions use an HttpOnly, SameSite=Strict cookie and a revocable server-side session record. Bearer tokens remain available for compatible API clients and automated tests.
- HTTPS is required for public production use. Enable `SECURE_COOKIES=true` only when HTTPS is active at the public endpoint.
- Local SQLite mode is intended for development/single-instance use. Configure Turso for the shared production application database. In-memory rate-limit counters remain per application instance.
- The included rate limiter is process-local. A multi-instance deployment should use a shared store such as Redis or an API gateway.
- Email verification, password reset email delivery, SSO, MFA, malware scanning, and enterprise retention automation are not included in this iteration.
- Avatar images load from user-provided HTTPS URLs. Production teams may prefer managed uploads, image validation, and an approved media domain allowlist.
- The local AI engine produces suggestions from stored project records and does not replace human approval or professional judgment.
- Operators remain responsible for backups, log/record retention, privacy notices, lawful data processing, access reviews, and incident response.
