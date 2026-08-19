# Orbit Workspace v2.7.1 — AI Everywhere

## What changed
- Generate AI Plan now calls a real external LLM when configured and falls back safely to the existing local planner if the provider is unavailable.
- Gemini support is built in using the server-side Interactions API and structured JSON output.
- Groq/OpenAI-compatible endpoints are also supported through environment variables.
- Inline **AI Suggest** controls are added to project-management writing fields including project intake, tasks, meeting notes, change requests, channel topics/messages and selected workspace text fields.
- Suggestions open in an editable review dialog with **Accept**, **Regenerate**, and **Cancel** controls. AI never writes to the field until the user accepts it.
- Meeting-note extraction, task regeneration, risk scanning and change-impact analysis use the external model when configured, with deterministic local fallbacks.
- AI status is visible in page headers as **AI connected** or **AI local mode**.
- API keys never go to the browser; provider calls are made only from the Node backend.

## Gemini setup
Add these environment variables locally in `.env` or on Render:

```env
ALLOW_EXTERNAL_AI=true
AI_PROVIDER=gemini
GEMINI_API_KEY=your_real_key
AI_MODEL=gemini-3-flash-preview
```

`AI_PROVIDER_URL` can stay blank for Gemini.

## Behavior without a key
The site still runs. Generate Plan, meeting analysis, change analysis, risk scan and field suggestions use the built-in local fallback and clearly report that mode in the UI.

## Data / database
Database persistence was completed in v2.8.0: when Turso is configured, the complete workspace now uses the shared remote libSQL database.
