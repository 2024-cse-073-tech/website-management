# Groq Free AI Setup (FlowMate v3.2.1)

FlowMate now defaults to Groq's OpenAI-compatible API with the production model `openai/gpt-oss-120b`.

## 1. Create your private Groq API key
Create the key in your own GroqCloud account. Never send or commit the key.

## 2. Create `.env` in the project root
Windows CMD:

```cmd
copy .env.example .env
notepad .env
```

Set only this secret:

```env
GROQ_API_KEY=PASTE_YOUR_PRIVATE_GROQ_KEY_HERE
```

The included defaults are already:

```env
ALLOW_EXTERNAL_AI=true
AI_PROVIDER=groq
AI_PROVIDER_URL=https://api.groq.com/openai/v1
AI_MODEL=openai/gpt-oss-120b
```

## 3. Restart FlowMate

```cmd
npm start
```

Then open:

- App: `http://127.0.0.1:8000`
- Health: `http://127.0.0.1:8000/api/health`

The AI health status should show `provider: groq`, `model: openai/gpt-oss-120b`, and `mode: external_ai`.

If the key is absent or the provider is unavailable, FlowMate intentionally falls back to the local planner instead of exposing secrets in the browser.
