'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function numberFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function booleanFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

loadEnv();

const root = path.resolve(__dirname, '..');
const databasePath = path.resolve(root, process.env.DATABASE_PATH || 'data/project_assistant_js.db');
const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const isProduction = nodeEnv === 'production';
const configuredSecret = String(process.env.TOKEN_SECRET || '').trim();
const aiProviderName = String(process.env.AI_PROVIDER || 'groq').trim().toLowerCase();
const aiProviderKey = (
  aiProviderName === 'gemini'
    ? (process.env.GEMINI_API_KEY || process.env.AI_PROVIDER_API_KEY || '')
    : aiProviderName === 'groq'
      ? (process.env.GROQ_API_KEY || process.env.AI_PROVIDER_API_KEY || '')
      : (process.env.AI_PROVIDER_API_KEY || '')
).trim();
const defaultAiModel = aiProviderName === 'gemini' ? 'gemini-3.6-flash' : 'openai/gpt-oss-120b';
const defaultAiUrl = aiProviderName === 'groq' ? 'https://api.groq.com/openai/v1' : '';

if (isProduction && configuredSecret.length < 32) {
  throw new Error('TOKEN_SECRET must be configured with at least 32 characters when NODE_ENV=production');
}

// Local development remains zero-config. Production is intentionally fail-closed above.
const developmentSecret = configuredSecret || crypto.createHash('sha256').update(`orbit-development:${root}`).digest('hex');

module.exports = {
  root,
  publicDir: path.join(root, 'public'),
  appBaseUrl: (process.env.APP_BASE_URL || '').trim().replace(/\/$/, ''),
  databasePath,
  host: process.env.HOST || '127.0.0.1',
  port: numberFromEnv('PORT', 8000, { min: 1, max: 65535 }),
  nodeEnv,
  isProduction,
  tokenSecret: developmentSecret,
  tokenTtlHours: numberFromEnv('TOKEN_TTL_HOURS', 24, { min: 1, max: 720 }),
  requestBodyLimitBytes: numberFromEnv('REQUEST_BODY_LIMIT_BYTES', 8_000_000, { min: 16_384, max: 12_000_000 }),
  requestTimeoutMs: numberFromEnv('REQUEST_TIMEOUT_MS', 30_000, { min: 5_000, max: 120_000 }),
  trustProxy: booleanFromEnv('TRUST_PROXY', false),
  secureCookies: booleanFromEnv('SECURE_COOKIES', isProduction),
  authRateLimitPer15Minutes: numberFromEnv('AUTH_RATE_LIMIT_PER_15_MINUTES', 60, { min: 10, max: 1000 }),
  apiRateLimitPerMinute: numberFromEnv('API_RATE_LIMIT_PER_MINUTE', 300, { min: 30, max: 5000 }),
  externalAi: {
    enabled: booleanFromEnv('ALLOW_EXTERNAL_AI', true),
    provider: aiProviderName,
    url: (process.env.AI_PROVIDER_URL || defaultAiUrl).trim(),
    key: aiProviderKey,
    model: (process.env.AI_MODEL || defaultAiModel).trim(),
    timeoutMs: numberFromEnv('AI_REQUEST_TIMEOUT_MS', 45_000, { min: 5_000, max: 120_000 })
  },
  turso: {
    url: (process.env.TURSO_DATABASE_URL || '').trim(),
    authToken: (process.env.TURSO_AUTH_TOKEN || '').trim()
  },
  smtp: {
    host: (process.env.SMTP_HOST || '').trim(),
    port: numberFromEnv('SMTP_PORT', 587, { min: 1, max: 65535 }),
    secure: booleanFromEnv('SMTP_SECURE', false),
    user: (process.env.SMTP_USER || '').trim(),
    pass: (process.env.SMTP_PASS || '').trim(),
    from: (process.env.SMTP_FROM || '').trim()
  },
  passwordResetCodeTtlMinutes: numberFromEnv('PASSWORD_RESET_CODE_TTL_MINUTES', 15, { min: 5, max: 60 })
};
