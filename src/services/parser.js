// AI message parser: OpenRouter + Gemini Flash, with mock fallback.
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const cache = require('./cache');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TOKEN_STATS_PATH = path.join(__dirname, '..', '..', 'data', 'token-stats.json');

// Primary model — what we try first. Overridable via env var.
const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

// Fallback chain — tried in order after the primary produces a weak result.
// Each entry is a different model / provider so a transient outage on one doesn't
// take the whole pipeline down. Order is: cheapest-and-fastest first, highest-
// reliability last. Anything that extracts fields is merged with the mock so no
// data is ever lost.
const FALLBACK_MODELS = [
  'google/gemini-2.0-flash-lite-001',   // same family, cheaper, very reliable
  'anthropic/claude-haiku-4-5',         // different provider — insurance against Google outages
];

// Gemini Flash 2.0 pricing on OpenRouter (USD per 1M tokens) — update when the
// model changes. Only used to estimate spend; authoritative figure is on OpenRouter.
const PRICE_PER_M = { input: 0.10, output: 0.40 };

function readTokenStats() {
  if (!fs.existsSync(TOKEN_STATS_PATH)) {
    return { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  }
  try { return JSON.parse(fs.readFileSync(TOKEN_STATS_PATH, 'utf8')); }
  catch { return { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }; }
}

function recordTokens(input, output) {
  const stats = readTokenStats();
  stats.calls += 1;
  stats.input_tokens += input || 0;
  stats.output_tokens += output || 0;
  stats.cost_usd += ((input || 0) * PRICE_PER_M.input + (output || 0) * PRICE_PER_M.output) / 1e6;
  stats.updated_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_STATS_PATH, JSON.stringify(stats, null, 2));
  return stats;
}

const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'settings.json');
const assigner = require('./assigner');

// Default prompt kept in sync with DEFAULT_PARSER_PROMPT in api.js.
// The authoritative copy is whichever is saved in settings.json; this is
// the fallback used when settings has no parser_prompt key.
const DEFAULT_SYSTEM_PROMPT = `You are a message parser for Arrowhead Asset Services, a commercial property maintenance company in Houston, TX.

You receive forwarded messages (texts or emails) from the sales team about client service requests. Extract structured data regardless of message format.

Extract these fields. If a field CANNOT be confidently determined, set it to null — never guess.

1. client_name: Client company or property management firm. Look in signatures, From lines, email domains. Do NOT use Arrowhead team member names as the client.
2. property_reference: Property name, location, or street address as written. Capture misspellings as-is.
3. work_type: Normalize to: sweeping, striping, pressure washing, painting, concrete repair, plumbing, HVAC, window cleaning, general maintenance, porter services, landscaping, signage, lighting, fencing, seal coating, pothole repair. Map abbreviations (PW=pressure washing, ADA=striping).
4. urgency: "normal", "urgent", or "asap". ASAP=emergency/today/safety issue. Urgent=end of week/rush/priority. Default "normal".
5. additional_context: Scope, areas, timeline, budget, special instructions, multiple properties/work types.
6. forwarder_context: Notes added by the Arrowhead team member who forwarded (appears before forwarded content).

EDGE CASES: Spam/auto-replies/newsletters → all fields null. Empty body → parse subject. Voice-to-text → best effort. Multi-forward chains → focus on original request. Multiple properties → primary here, rest in additional_context.

Return ONLY a valid JSON object with these 6 fields. No explanation, no markdown, no code fences.`;

function getSystemPrompt() {
  let prompt = DEFAULT_SYSTEM_PROMPT;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (settings.parser_prompt && typeof settings.parser_prompt === 'string') {
      prompt = settings.parser_prompt;
    }
  } catch { /* use default */ }
  return interpolateVariables(prompt);
}

function interpolateVariables(prompt) {
  const properties = cache.getProperties();
  const propertyNames = properties.map((p) => p.name).filter(Boolean);
  const clientNames = [...new Set(properties.map((p) => p.client_name).filter(Boolean))];

  let assignConfig = { team_members: [], escalation_keywords: [] };
  try { assignConfig = assigner.readConfig(); } catch { /* defaults */ }

  const workTypes = 'sweeping, striping, pressure washing, painting, concrete repair, plumbing, HVAC, window cleaning, general maintenance, porter services';
  const today = new Date().toISOString().slice(0, 10);

  return prompt
    .replace(/\{\{property_list\}\}/g, propertyNames.join(', ') || '(no properties cached)')
    .replace(/\{\{client_list\}\}/g, clientNames.join(', ') || '(no clients cached)')
    .replace(/\{\{team_members\}\}/g, assignConfig.team_members.join(', ') || '(no team members)')
    .replace(/\{\{work_types\}\}/g, workTypes)
    .replace(/\{\{date\}\}/g, today)
    .replace(/\{\{escalation_keywords\}\}/g, (assignConfig.escalation_keywords || []).join(', ') || '(none)');
}

function isConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

async function parseWithModel(message, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const systemPrompt = getSystemPrompt();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://choosearrowhead.com',
      'X-Title': 'Arrowhead Intake Agent',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');
  const usage = data.usage || {};
  recordTokens(usage.prompt_tokens, usage.completion_tokens);
  return extractJson(content);
}

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Try to find first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse JSON from LLM response');
  }
}

// ---------- Mock parser ----------

const WORK_TYPES = [
  'pressure washing', 'sweeping', 'striping', 'painting', 'concrete repair',
  'concrete', 'plumbing', 'HVAC', 'window cleaning', 'porter services',
  'restripe', 'repaint',
];

const URGENCY_KEYWORDS = {
  asap: ['asap', 'emergency', 'today', 'right away', 'immediately', 'urgent — today'],
  urgent: ['urgent', 'as soon as possible', 'end of week', 'before weekend', 'end of month', 'needs to be done'],
};

function detectUrgency(text) {
  const lower = text.toLowerCase();
  for (const kw of URGENCY_KEYWORDS.asap) if (lower.includes(kw)) return 'asap';
  for (const kw of URGENCY_KEYWORDS.urgent) if (lower.includes(kw)) return 'urgent';
  return 'normal';
}

function detectWorkType(text) {
  const lower = text.toLowerCase();
  for (const wt of WORK_TYPES) {
    if (lower.includes(wt)) {
      if (wt === 'restripe') return 'striping';
      if (wt === 'repaint') return 'painting';
      if (wt === 'concrete') return 'concrete repair';
      return wt;
    }
  }
  return null;
}

function detectPropertyReference(text) {
  const properties = cache.getProperties();
  const lower = text.toLowerCase();

  // 1. Full property name verbatim
  for (const p of properties) {
    if (lower.includes(p.name.toLowerCase())) return p.name;
  }
  // 2. Longest-prefix match — try 3-word, then 2-word prefixes so
  //    specific names ("Sterling Plaza", "Sterling Place") beat generic ones ("Sterling").
  for (const len of [3, 2]) {
    let best = null;
    for (const p of properties) {
      const words = p.name.split(/\s+/);
      if (words.length < len) continue;
      const prefix = words.slice(0, len).join(' ').toLowerCase();
      if (prefix.length <= 4) continue;
      if (lower.includes(prefix)) {
        if (!best || prefix.length > best.length) best = prefix;
      }
    }
    if (best) return best;
  }
  // 3. Single-word fallback
  for (const p of properties) {
    const firstWord = p.name.split(/\s+/)[0].toLowerCase();
    if (firstWord.length > 3 && lower.includes(firstWord)) return firstWord;
  }
  // 4. Address like "15800 Memorial Dr"
  const addrMatch = text.match(/\d{3,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:Dr|Rd|St|Blvd|Ave)/);
  if (addrMatch) return addrMatch[0];
  // 5. "at X" or "@ X" — grab next chunk
  const atMatch = text.match(/(?:at|@)\s+([a-z0-9][\w\s]{2,40})/i);
  if (atMatch) return atMatch[1].trim().split(/[.,!?]/)[0].trim();
  return null;
}

function detectClientName(text) {
  const properties = cache.getProperties();
  const lower = text.toLowerCase();
  const clients = [...new Set(properties.map((p) => p.client_name).filter(Boolean))];
  for (const c of clients) {
    if (lower.includes(c.toLowerCase())) return c;
    // Match "Greystar", "Hines", "JLL", etc (short client names)
    const shortName = c.split(' ')[0];
    if (shortName.length > 3 && lower.includes(shortName.toLowerCase())) return c;
  }
  return null;
}

function detectForwarderContext(text) {
  const m = text.match(/^(?:from|fwd|forwarding|heads up|just got off|got a request)[^.\n]+/i);
  return m ? m[0].trim() : null;
}

function mockParse(message) {
  return {
    client_name: detectClientName(message),
    property_reference: detectPropertyReference(message),
    work_type: detectWorkType(message),
    urgency: detectUrgency(message),
    additional_context: message.length > 60 ? message.slice(0, 240) : null,
    forwarder_context: detectForwarderContext(message),
  };
}

// A parse is "complete enough" if it has at least property_reference and work_type.
function scoreResult(p) {
  if (!p) return 0;
  let s = 0;
  if (p.property_reference) s += 3;
  if (p.work_type) s += 3;
  if (p.urgency && p.urgency !== 'normal') s += 1;
  if (p.client_name) s += 2;
  if (p.additional_context) s += 1;
  if (p.forwarder_context) s += 1;
  return s;
}

// Merge two parse results — prefer non-null values from `primary`, fill missing
// ones from `secondary`. This is the "no data lost" promise: anything any parser
// extracted survives into the final result.
function mergeResults(primary, secondary) {
  const fields = ['client_name', 'property_reference', 'work_type', 'urgency', 'additional_context', 'forwarder_context'];
  const out = {};
  for (const f of fields) {
    const a = primary?.[f];
    const b = secondary?.[f];
    if (a !== null && a !== undefined && a !== '') out[f] = a;
    else if (b !== null && b !== undefined && b !== '') out[f] = b;
    else out[f] = null;
  }
  return out;
}

// Resilient parse: try a chain of models, always fall back to mock, merge with
// mock output so any rule-based extraction is preserved even when the LLM misses.
async function parse(message) {
  const attempts = [];
  let bestLLM = null;
  let bestScore = 0;
  let bestModel = null;

  if (isConfigured()) {
    const chain = [PRIMARY_MODEL, ...FALLBACK_MODELS];
    for (const model of chain) {
      try {
        const parsed = await parseWithModel(message, model);
        const score = scoreResult(parsed);
        attempts.push({ model, ok: true, score });
        logger.info(`Parser: ${model} succeeded (score=${score})`);
        if (score > bestScore) {
          bestLLM = parsed;
          bestScore = score;
          bestModel = model;
        }
        // If the primary returns a strong parse (property + work type + client),
        // accept immediately without trying fallbacks (saves tokens).
        if (score >= 8) break;
      } catch (err) {
        attempts.push({ model, ok: false, error: err.message });
        logger.warn(`Parser: ${model} failed — ${err.message}`);
      }
    }
  }

  // Always run the mock parser too, so rule-based extraction (property name
  // matching from the cached master listing) never gets dropped even when the
  // LLM succeeds but misses a field.
  const mocked = mockParse(message);
  attempts.push({ model: 'mock', ok: true, score: scoreResult(mocked) });

  // Merge LLM (primary) with mock (fills gaps).
  const parsed = bestLLM ? mergeResults(bestLLM, mocked) : mocked;
  const source = bestLLM ? `${bestModel}+mock` : 'mock';

  logger.info(`Parser: final source=${source}, score=${scoreResult(parsed)}, attempts=${attempts.length}`);
  return { parsed, source, attempts };
}

module.exports = { parse, mockParse, isConfigured, readTokenStats };
