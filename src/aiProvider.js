'use strict';

const config = require('./config');

class AiProviderError extends Error {
  constructor(message, { status = 502, provider = '' } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
    this.provider = provider;
  }
}

function enabled() {
  return Boolean(config.externalAi.enabled && config.externalAi.key && config.externalAi.model);
}

function providerName() {
  if (!enabled()) return 'local_fallback';
  return config.externalAi.provider || 'gemini';
}

function status() {
  return {
    enabled: enabled(),
    provider: providerName(),
    model: enabled() ? config.externalAi.model : 'local-rule-engine',
    mode: enabled() ? 'external_ai' : 'local_fallback'
  };
}

function stripCodeFence(value) {
  return String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractGeminiText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const collectionName of ['steps', 'outputs']) {
    const collection = Array.isArray(payload?.[collectionName]) ? payload[collectionName] : [];
    for (const item of collection) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text.trim()) return part.text;
      }
    }
  }
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string' && part.text.trim()) return part.text;
    }
  }
  return '';
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.externalAi.timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`;
      throw new AiProviderError(`AI provider request failed: ${detail}`, { status: response.status, provider: providerName() });
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new AiProviderError('AI provider request timed out', { status: 504, provider: providerName() });
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError(`AI provider is unavailable: ${error.message}`, { provider: providerName() });
  } finally {
    clearTimeout(timer);
  }
}

async function geminiJson({ system, prompt, schema }) {
  const base = (config.externalAi.url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/interactions`;
  const fullPrompt = `${system}\n\n${prompt}`;
  const payload = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.externalAi.key
    },
    body: JSON.stringify({
      model: config.externalAi.model,
      input: fullPrompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema
      }
    })
  });
  const text = extractGeminiText(payload);
  if (!text) throw new AiProviderError('Gemini returned an empty response', { provider: 'gemini' });
  try { return JSON.parse(stripCodeFence(text)); }
  catch { throw new AiProviderError('Gemini returned invalid structured JSON', { provider: 'gemini' }); }
}

async function openAiCompatibleJson({ system, prompt, schema }) {
  const base = (config.externalAi.url || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const provider = String(config.externalAi.provider || '').toLowerCase();
  const isGroqGptOss = provider === 'groq' && /^openai\/gpt-oss-(?:20b|120b)$/i.test(config.externalAi.model);
  const requestBody = {
    model: config.externalAi.model,
    temperature: 0.35,
    messages: [
      { role: 'system', content: `${system}\nReturn only JSON matching the requested schema. Do not add markdown.` },
      { role: 'user', content: `${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}` }
    ],
    response_format: isGroqGptOss
      ? { type: 'json_schema', json_schema: { name: 'flowmate_response', strict: false, schema } }
      : { type: 'json_object' }
  };
  if (isGroqGptOss) {
    requestBody.reasoning_effort = 'medium';
    requestBody.include_reasoning = false;
  }
  const payload = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.externalAi.key}`
    },
    body: JSON.stringify(requestBody)
  });
  const text = payload?.choices?.[0]?.message?.content || '';
  if (!text) throw new AiProviderError('AI provider returned an empty response', { provider: providerName() });
  try { return JSON.parse(stripCodeFence(text)); }
  catch { throw new AiProviderError('AI provider returned invalid JSON', { provider: providerName() }); }
}

async function generateJson({ system, prompt, schema }) {
  if (!enabled()) throw new AiProviderError('External AI is not configured', { status: 503, provider: 'local_fallback' });
  const provider = String(config.externalAi.provider || 'gemini').toLowerCase();
  if (provider === 'gemini') return geminiJson({ system, prompt, schema });
  if (['openai', 'openai_compatible', 'groq'].includes(provider)) return openAiCompatibleJson({ system, prompt, schema });
  throw new AiProviderError(`Unsupported AI_PROVIDER: ${provider}`, { status: 500, provider });
}

module.exports = { AiProviderError, enabled, providerName, status, generateJson };
