# ProjectFlow v2.8.0 — Database Setup Step by Step

## Goal

After this setup, the deployed website uses one cloud database. A user can sign in from mobile or laptop and see the same saved workspace data, and app redeploys do not depend on the Render container's local SQLite file.

## Part A — Create database

1. Sign in to Turso.
2. Create a new database named `projectflow-prod`.
3. Choose **libSQL** if the dashboard asks which database engine to use.
4. Copy the database URL. It should normally begin with `libsql://`.
5. Create/copy a database auth token.
6. Keep both values private.

You will have:

```text
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

## Part B — Optional local cloud-database test

In the project `.env`, add your Turso values:

```env
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
```

Then restart:

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:8000/api/health/ready
```

You want:

```text
"database_storage":"turso"
"persistent":true
```

Now create a test account/project. Because this `.env` points to Turso, the same cloud records will be visible when the deployed app uses the same database credentials.

## Part C — Add database to Render

In Render -> your Web Service -> Environment, add:

```text
TURSO_DATABASE_URL    <your libsql URL>
TURSO_AUTH_TOKEN      <your token>
```

Also set the required production values:

```text
NODE_ENV              production
HOST                  0.0.0.0
TOKEN_SECRET          <random 32+ character secret>
SECURE_COOKIES        true
TRUST_PROXY           true
```

Keep your AI configuration there as well:

```text
ALLOW_EXTERNAL_AI     true
AI_PROVIDER           gemini
GEMINI_API_KEY        <your key>
AI_MODEL              gemini-3.6-flash
```

For Forgot Password in production, also add SMTP variables from `RENDER_REDEPLOY_GUIDE.md`.

## Part D — Deploy

Use:

```text
Build Command: npm install
Start Command: npm start
```

Deploy the latest commit.

## Part E — Verify before real users

Visit:

```text
https://YOUR-SITE/api/health/ready
```

Do not start real production use until the response shows:

```json
"database_storage": "turso",
"persistent": true
```

Then test sign-up, organization, project, task, AI plan, logout/login, a second device, and one Render redeploy.
