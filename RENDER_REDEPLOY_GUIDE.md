# Render Redeploy Guide — Full Persistent Database (v2.8.0)

This build can use **one Turso libSQL cloud database for the complete application**, not only login data.

When `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are configured, the following records are stored remotely: users, login sessions, password-reset codes, organizations, memberships, invitations, profiles/presence, settings, notifications, account activity, channels, messages, projects, source records, tasks, dependencies, risks, decisions, updates, change requests, AI suggestions/plans, and audit logs.

If Turso variables are not configured, local development automatically falls back to `data/project_assistant_js.db`.

## 1. Create a Turso **libSQL** database

Use a Turso account and create a **libSQL** database such as `projectflow-prod`.

If using the Turso CLI, create it without the `--tursodb` flag:

```bash
turso db create projectflow-prod
turso db show projectflow-prod --url
turso db tokens create projectflow-prod
```

You need exactly two database secrets for the app:

```text
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

Do not commit the auth token to GitHub.

## 2. Render environment variables

Open the Render Web Service -> Environment and add:

```env
NODE_ENV=production
HOST=0.0.0.0
TOKEN_SECRET=replace-with-a-random-secret-of-at-least-32-characters
SECURE_COOKIES=true
TRUST_PROXY=true

TURSO_DATABASE_URL=libsql://your-database...
TURSO_AUTH_TOKEN=your-secret-token

ALLOW_EXTERNAL_AI=true
AI_PROVIDER=groq
GROQ_API_KEY=your-private-groq-api-key
AI_PROVIDER_URL=https://api.groq.com/openai/v1
AI_MODEL=openai/gpt-oss-120b
```

Do not manually set `PORT` if Render provides it.

## 3. Forgot-password email (recommended before public launch)

The production Forgot Password flow needs SMTP. A Gmail example is:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM=your-email@gmail.com
PASSWORD_RESET_CODE_TTL_MINUTES=15
```

Use an App Password rather than your normal Gmail password when Google requires it.

## 4. Render build/start

For Render's Node runtime:

```text
Build Command: npm install
Start Command: npm start
```

The project requires Node.js 22.5+ and declares that requirement in `package.json`.

If you deploy with the included Dockerfile, it installs the production dependencies itself.

## 5. Verify the database after deploy

Open:

```text
https://YOUR-RENDER-DOMAIN/api/health/ready
```

Correct Turso configuration should include:

```json
{
  "status": "ready",
  "database_storage": "turso",
  "persistent": true
}
```

If it says `local-sqlite`, your Turso variables were not loaded. Do not create production users until this shows `turso`.

## 6. Persistence test

1. Sign up on the deployed website.
2. Create an organization.
3. Create a project and one task.
4. Send a test channel message or generate an AI plan.
5. Log out and sign back in from another browser/device.
6. Confirm the same organization/project/task is present.
7. Trigger a Render redeploy/restart.
8. Sign back in and confirm the same data is still present.

## 7. Important behavior

- `npm run reset` intentionally refuses to run while Turso credentials are configured. This prevents accidentally wiping/reinitializing production data through the local reset helper.
- Local SQLite is still available for development if the two Turso variables are absent.
- Never commit `.env`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `TURSO_AUTH_TOKEN`, `TOKEN_SECRET`, or `SMTP_PASS`.
