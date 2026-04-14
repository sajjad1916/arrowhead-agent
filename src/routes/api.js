const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const auth = require('../middleware/auth');
const pipeline = require('../pipeline');
const cache = require('../services/cache');
const assigner = require('../services/assigner');
const monday = require('../services/monday');
const parser = require('../services/parser');
const logger = require('../utils/logger');

const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'settings.json');

const DEFAULT_PARSER_PROMPT = `You are a message parser for Arrowhead Asset Services, a commercial property maintenance company in Houston, TX that does parking-lot striping, sweeping, pressure washing, painting, concrete repair, and general exterior maintenance.

You receive forwarded messages (texts or emails) from the sales team about client service requests. Messages may be clean single-line SMS texts, formal RFP emails, messy multi-forwarded email chains, voice-to-text transcriptions, or anything in between. Your job is to extract structured data regardless of format.

Extract the following fields. If a field CANNOT be confidently determined, set it to null — never guess or fabricate.

1. client_name: The client company or property management firm requesting work.
   - Look for company names in signatures, "From:" lines, email domains, or body text.
   - Common clients are property management firms (Greystar, Hines, JLL, CBRE, Cushman & Wakefield, etc.).
   - If only a person's name is visible (e.g. "Nathan Torres"), check if they represent a company. If unclear, set client_name to null.
   - Do NOT use the Arrowhead team member's name as the client.

2. property_reference: Any mention of a property name, location, or street address.
   - Accept full names ("Sterling Plaza Shopping Center"), partial names ("Sterling Plaza"), nicknames ("the Sterling property"), or street addresses ("8350 Westheimer Rd").
   - If a message says "the usual place" or "same location" with no name, set to null.
   - If multiple properties are mentioned, capture the PRIMARY one here. Note the others in additional_context.
   - Common misspellings should be captured as-is — the matching system handles fuzzy lookup.

3. work_type: The type of maintenance work. Normalize to one of these categories when possible:
   sweeping, striping, pressure washing, painting, concrete repair, plumbing, HVAC, window cleaning, general maintenance, porter services, landscaping, signage, lighting, fencing, seal coating, pothole repair
   - Map abbreviations: "PW" = pressure washing, "ADA" = striping (ADA-compliant spaces), "re-stripe" / "restripe" = striping, "repaint" = painting, "lot sweep" = sweeping
   - If multiple work types are requested, pick the primary one and list the rest in additional_context.
   - If the work type is ambiguous (e.g. "maintenance needed"), use "general maintenance".

4. urgency: One of "normal", "urgent", or "asap".
   - ASAP signals: "ASAP", "emergency", "today", "right away", "immediately", "someone could get hurt", "tripping hazard", "safety issue", "liability", "tenant threatening to leave"
   - Urgent signals: "urgent", "end of week", "before the weekend", "as soon as possible", "rush", "priority", "time-sensitive", "need this quickly", "fast turnaround"
   - If no urgency signals are present, default to "normal". Do NOT infer urgency from work type alone.
   - "End of month" or "next month" = normal. "This week" = urgent. "Today" = asap.

5. additional_context: Any other relevant details. Capture ALL of the following if present:
   - Specific areas of the property (e.g. "north parking lot", "east entrance", "loading dock")
   - Square footage or scope estimates
   - Timeline preferences ("by end of month", "next quarter", "before holiday season")
   - Budget mentions ("keep it under $5000", "$10k budget approved")
   - Special instructions ("same colors as 2022", "match existing", "needs to be done at night")
   - Crew/equipment preferences
   - If MULTIPLE properties or work types are mentioned, list them here
   - Contact info for the requesting party (phone numbers, alternate emails)
   - If this is a multi-property bid request, note that

6. forwarder_context: Capture notes added by the Arrowhead team member who forwarded the message.
   - These appear BEFORE the forwarded content: "from Nathan at Lakeside", "got this from David", "heads up — this is urgent", "just got off the phone with..."
   - Also capture: "this is a repeat client", "budget approved", "Nathan will handle", "CC'd the PM"
   - Do NOT confuse the original sender's message with the forwarder's note.

EDGE CASES — handle these correctly:
- SPAM / IRRELEVANT: If the message is clearly spam, a marketing newsletter, an auto-reply ("Out of Office"), a calendar invite, or unrelated to maintenance work, return ALL fields as null.
- EMPTY/MINIMAL: If the subject line contains the request but the body is empty, parse the subject.
- VOICE-TO-TEXT: Messages may have no punctuation, run-on sentences, or phonetic misspellings. Parse best-effort.
- FORWARDED CHAINS: Multiple "Fwd:" or "---------- Forwarded message ----------" layers. Focus on the ORIGINAL request, not the forwarding metadata.
- SHORT SMS: Messages like "need sweeping at sterling asap" — extract what you can from minimal text.
- MULTI-PROPERTY: "Need quotes for 4 Hines properties" — capture the first/primary, note the rest in additional_context.
- SIMILAR NAMES: "Sterling Plaza" vs "Sterling Place" — capture exactly as written. Do not correct to a known property name.
- REPLY CHAINS: Focus on the MOST RECENT message, not the full conversation history.

Return ONLY a valid JSON object with these 6 fields. No explanation, no markdown, no code fences.`;

const DEFAULT_SETTINGS = {
  demo_mode: true,
  parser_prompt: DEFAULT_PARSER_PROMPT,
};

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// All routes below require auth
router.use(auth.requireAuth);

// ---------- Stats ----------
router.get('/stats', async (req, res) => {
  const tickets = pipeline.readTickets();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const today = tickets.filter((t) => t.created_at >= startOfDay);
  const week = tickets.filter((t) => t.created_at >= weekAgo);
  const flagged = tickets.filter((t) => t.flag && t.flag !== 'ok');
  const autoRouted = tickets.filter((t) => t.flag === 'ok');
  const matched = tickets.filter((t) => t.flag === 'ok' || t.property);
  const matchRate = tickets.length > 0 ? Math.round((matched.length / tickets.length) * 100) : 0;

  // Breakdown by source (lifetime)
  const bySource = { email: 0, sms: 0 };
  for (const t of tickets) {
    if (t.source === 'email') bySource.email++;
    else if (t.source === 'sms') bySource.sms++;
  }

  // Live count of tickets still at stage=Ready to Process on Monday.com.
  // Returns null if Monday is not configured or the query fails.
  let openOnMonday = null;
  if (monday.isConfigured()) {
    openOnMonday = await monday.countOpenTickets();
  }

  // Token / spend totals
  let tokens = null;
  try { tokens = parser.readTokenStats(); } catch { tokens = null; }

  res.json({
    today: today.length,
    week: week.length,
    flagged: flagged.length,
    autoRouted: autoRouted.length,
    matchRate,
    total: tickets.length,
    bySource,
    openOnMonday,
    tokens,
  });
});

// ---------- Tickets ----------
// Paginated. Default page=1, pageSize=50. Supports urgency/flag/source filters
// plus a free-text `q` that matches client, property, address, work_type, or
// raw_message. At ~200 messages/day a single table grows fast; paginating
// keeps the dashboard responsive regardless of history size.
router.get('/tickets', (req, res) => {
  const tickets = pipeline.readTickets();
  const { urgency, flag, source, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

  let filtered = tickets;
  if (urgency) filtered = filtered.filter((t) => t.urgency === urgency);
  if (flag) filtered = filtered.filter((t) => t.flag === flag);
  if (source) filtered = filtered.filter((t) => t.source === source);
  if (q) {
    const needle = String(q).toLowerCase();
    filtered = filtered.filter((t) =>
      [t.client_name, t.property, t.address, t.work_type, t.ticket_name, t.raw_message]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle))
    );
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  res.json({
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

router.get('/tickets/recent', (req, res) => {
  const tickets = pipeline.readTickets();
  res.json(tickets.slice(0, 20));
});

router.delete('/tickets', (req, res) => {
  pipeline.clearTickets();
  res.json({ ok: true });
});

// ---------- Assignment Config ----------
router.get('/assignment-config', (req, res) => {
  res.json(assigner.readConfig());
});

router.put('/assignment-config', (req, res) => {
  const current = assigner.readConfig();
  const next = { ...current, ...req.body };
  if (typeof next.current_index !== 'number') next.current_index = 0;
  assigner.writeConfig(next);
  res.json(next);
});

// ---------- Property Cache ----------
router.get('/property-cache', (req, res) => {
  res.json(cache.readCache());
});

// Lightweight health endpoint for the dashboard cache badge. The full
// property list can be hundreds of KB at scale; don't ship it just to
// render "updated 34s ago · webhook healthy".
router.get('/property-cache/status', (req, res) => {
  res.json(cache.getStatus());
});

router.post('/property-cache/refresh', async (req, res) => {
  const result = await cache.refresh();
  res.json(result);
});

// ---------- Settings ----------
router.get('/settings', async (req, res) => {
  const settings = readSettings();
  const connections = {
    monday: monday.isConfigured(),
    openrouter: parser.isConfigured(),
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    gmail: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN),
  };
  // Live-check Monday if configured
  if (connections.monday) {
    connections.monday_live = await monday.testConnection();
  }
  const agent_contact = {
    email: process.env.AGENT_EMAIL || '',
    phone: process.env.AGENT_PHONE || process.env.TWILIO_PHONE_NUMBER || '',
  };
  res.json({ settings, connections, agent_contact });
});

router.put('/settings', (req, res) => {
  const current = readSettings();
  const next = { ...current, ...req.body };
  writeSettings(next);
  res.json(next);
});

// ---------- Monday.com Connection & Board Config ----------

// Default display labels for agent fields
const DEFAULT_FIELD_LABELS = {
  properties: {
    client_name: 'Client Name',
    address: 'Address',
    property_manager: 'Property Manager',
    manager_phone: 'Manager Phone',
    manager_email: 'Manager Email',
  },
  quotes: {
    stage: 'Stage',
    client_name: 'Client Name',
    address: 'Address',
    work_type: 'Work Type',
    urgency: 'Urgency',
    original_message: 'Original Message',
    flag: 'Flag',
    property_manager: 'Property Manager',
  },
};

function getFieldLabels() {
  const settings = readSettings();
  return {
    properties: { ...DEFAULT_FIELD_LABELS.properties, ...(settings.monday_field_labels_properties || {}) },
    quotes: { ...DEFAULT_FIELD_LABELS.quotes, ...(settings.monday_field_labels_quotes || {}) },
  };
}

// Current connection state + selected boards + column mappings + labels
router.get('/monday-config', (req, res) => {
  const settings = readSettings();
  const cols = monday.COLS;
  const labels = getFieldLabels();
  const connected = monday.isConfigured();
  res.json({
    connected,
    has_key: !!(settings.monday_api_key || process.env.MONDAY_API_KEY),
    input_board_id: settings.monday_input_board_id || process.env.MONDAY_PROPERTY_BOARD_ID || '',
    output_board_id: settings.monday_output_board_id || process.env.MONDAY_QUOTES_BOARD_ID || '',
    quotes: {
      board_id: monday.getQuotesBoardId(),
      columns: Object.entries(cols.quotes).map(([field, colId]) => ({
        field,
        label: labels.quotes[field] || field,
        column_id: colId,
      })),
    },
    properties: {
      board_id: monday.getPropertyBoardId(),
      columns: Object.entries(cols.properties).map(([field, colId]) => ({
        field,
        label: labels.properties[field] || field,
        column_id: colId,
      })),
    },
  });
});

// Get just the field labels (used by ticket feed)
router.get('/field-labels', (req, res) => {
  res.json(getFieldLabels());
});

// Save field mappings: labels + column IDs for a board type (properties or quotes)
router.put('/monday-field-config', (req, res) => {
  const { board_type, labels, column_ids } = req.body || {};
  if (!board_type || !['properties', 'quotes'].includes(board_type)) {
    return res.status(400).json({ error: 'board_type must be "properties" or "quotes"' });
  }
  const current = readSettings();
  if (labels && typeof labels === 'object') {
    current[`monday_field_labels_${board_type}`] = labels;
  }
  if (column_ids && typeof column_ids === 'object') {
    current[`monday_cols_${board_type}`] = column_ids;
  }
  writeSettings(current);
  res.json({ ok: true });
});

// Connect: save API key + test it
router.post('/monday-connect', async (req, res) => {
  const { api_key } = req.body || {};
  if (!api_key || typeof api_key !== 'string') {
    return res.status(400).json({ error: 'api_key is required' });
  }
  const result = await monday.testConnectionWithKey(api_key.trim());
  if (!result.ok) {
    return res.status(400).json({ error: result.error || 'Connection failed' });
  }
  // Save the key
  const current = readSettings();
  current.monday_api_key = api_key.trim();
  writeSettings(current);
  res.json({ ok: true, user: result.user });
});

// Disconnect: remove saved key + board selections
router.post('/monday-disconnect', (req, res) => {
  const current = readSettings();
  delete current.monday_api_key;
  delete current.monday_input_board_id;
  delete current.monday_output_board_id;
  writeSettings(current);
  res.json({ ok: true });
});

// List boards on the connected account
router.get('/monday-boards', async (req, res) => {
  const settings = readSettings();
  const apiKey = settings.monday_api_key || process.env.MONDAY_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Monday.com not connected' });
  try {
    const boards = await monday.discoverBoardsWithKey(apiKey);
    res.json({ boards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save selected input/output boards
router.put('/monday-boards', (req, res) => {
  const { input_board_id, output_board_id } = req.body || {};
  const current = readSettings();
  if (input_board_id !== undefined) current.monday_input_board_id = input_board_id;
  if (output_board_id !== undefined) current.monday_output_board_id = output_board_id;
  writeSettings(current);
  res.json({ ok: true, input_board_id: current.monday_input_board_id, output_board_id: current.monday_output_board_id });
});

// Fetch columns for a board
router.get('/monday-columns/:boardId', async (req, res) => {
  if (!monday.isConfigured()) return res.status(400).json({ error: 'Monday.com not connected' });
  try {
    const columns = await monday.fetchBoardColumns(req.params.boardId);
    res.json({ columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Parser Prompt ----------
router.get('/parser-prompt', (req, res) => {
  const settings = readSettings();
  res.json({
    prompt: settings.parser_prompt || DEFAULT_PARSER_PROMPT,
    default_prompt: DEFAULT_PARSER_PROMPT,
    variables: [
      { key: '{{property_list}}', label: 'Property names', description: 'Comma-separated list of all property names from the cache' },
      { key: '{{client_list}}', label: 'Client names', description: 'Comma-separated list of all client company names' },
      { key: '{{team_members}}', label: 'Team members', description: 'Current round-robin team member names' },
      { key: '{{work_types}}', label: 'Work types', description: 'Common work type categories' },
      { key: '{{date}}', label: 'Today\'s date', description: 'Current date (YYYY-MM-DD)' },
      { key: '{{escalation_keywords}}', label: 'Escalation keywords', description: 'Keywords that trigger urgent escalation' },
    ],
  });
});

router.put('/parser-prompt', (req, res) => {
  const { prompt } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
  }
  const current = readSettings();
  current.parser_prompt = prompt;
  writeSettings(current);
  res.json({ prompt: current.parser_prompt });
});

router.post('/parser-prompt/reset', (req, res) => {
  const current = readSettings();
  current.parser_prompt = DEFAULT_PARSER_PROMPT;
  writeSettings(current);
  res.json({ prompt: DEFAULT_PARSER_PROMPT });
});

// ---------- Demo pipeline ----------
router.post('/demo/process', async (req, res) => {
  const { message, source } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!['sms', 'email'].includes(source)) {
    return res.status(400).json({ error: 'source must be sms or email' });
  }
  try {
    const result = await pipeline.runPipeline({ message, source });
    res.json(result);
  } catch (err) {
    logger.error('Pipeline failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Test Buttons ----------
// "Get test email" — simulates receiving an email via the pipeline.
// Body: { template: "sterling-pressure-wash" } OR { message, source }
const EMAIL_TEMPLATES = {
  'formal-rfp-sterling': {
    subject: 'Pressure Washing Quote Request — Sterling Plaza',
    body: `---------- Forwarded message ----------
From: Nathan Torres <ntorres@greystar.com>
To: Sales <sales@choosearrowhead.com>
Subject: Pressure Washing Quote Request — Sterling Plaza
Date: Mon, 13 Apr 2026 09:12:00 -0500

Hi team,

Please provide a quote for pressure washing the north and south parking lots at Sterling Plaza Shopping Center. Approximately 50,000 sq ft total. We'd like to complete before end of month.

Thanks,
Nathan Torres
Greystar Property Management`,
  },
  'voice-note-post-oak': {
    subject: 'Voice note — Post Oak repaint',
    body: `Just got off the phone with Michael at Post Oak Central. He wants a bid for repainting the exterior trim on the north face of the building — same colors as we used in 2022. He said budget approval is already in place. Wants an estimate by Friday if possible. He mentioned a few small areas where the trim has peeled badly from sun exposure. He'll email photos later. Not urgent but he'd like to get the crew in next month.`,
  },
  'forwarded-chain-lakeside': {
    subject: 'Fwd: Fwd: Lakeside — striping needed',
    body: `---------- Forwarded message ----------
From: David Kim <dkim@lakesideproperties.com>
Subject: Lakeside — striping needed

Team,

Can you send this to Arrowhead please.

Begin forwarded message:

From: Property Manager <pm@lakesideproperties.com>
To: David Kim <dkim@lakesideproperties.com>

David — the lot at Lakeside Corporate Park is looking rough. Full restripe needed including ADA spaces. Can we get Arrowhead out? End of month would be ideal.

Thanks`,
  },
  'multi-property-hines': {
    subject: 'Window cleaning bids — 4 Hines properties',
    body: `Hi team,

Hines wants quarterly window cleaning bids across all 4 of their properties:
- Hines Building I
- Hines Building II
- Hines Building III
- Hines Building IV

Michael Chang is the point of contact. He'd like pricing by end of next week.

Thanks,
Jana`,
  },
  'urgent-emergency': {
    subject: 'URGENT — Energy Corridor sidewalk',
    body: `EMERGENCY — Roberto says tripping hazard at Energy Corridor Tower main sidewalk. Someone could get hurt. Need concrete repair TODAY.`,
  },
  'vague-unknown-property': {
    subject: 'Quote request',
    body: `Hi, got a request for sweeping at some plaza on main street. Property manager didn't give me a name. Can someone follow up?`,
  },
};

const SMS_TEMPLATES = {
  'one-line-sterling': 'need sweeping at sterling asap',
  'forwarder-note-lakeside': 'from David at Lakeside — wants full restripe including ADA spots. End of month.',
  'address-only': 'Client wants pressure washing at the property on 15800 Memorial Dr',
  'similar-name-test': 'Need painting at Sterling Place',
  'short-text-cypress': 'sweeping @ cypress mill',
  'multi-service': 'Need pressure washing AND striping at Energy Corridor. Also the concrete on the east entrance is cracking.',
  'new-client': 'New client inquiry — Sarah from Bayou Properties wants a quote for monthly sweeping at their complex on Richmond. Never worked with them before.',
  'unknown-property': 'Got a request for sweeping at some plaza on main street. No other details.',
};

router.get('/templates', (req, res) => {
  res.json({
    email: Object.entries(EMAIL_TEMPLATES).map(([key, v]) => ({ key, subject: v.subject, body: v.body })),
    sms: Object.entries(SMS_TEMPLATES).map(([key, body]) => ({ key, body })),
  });
});

// One-click test endpoint — picks a template and runs pipeline.
router.post('/test/get-email', async (req, res) => {
  const { template = 'sterling-pressure-wash' } = req.body || {};
  const tpl = EMAIL_TEMPLATES[template];
  if (!tpl) return res.status(400).json({ error: 'Unknown email template' });
  const result = await pipeline.runPipeline({
    message: tpl.body,
    source: 'email',
  });
  res.json({ template: { key: template, subject: tpl.subject, body: tpl.body }, ...result });
});

router.post('/test/get-sms', async (req, res) => {
  const { template = 'sterling-sweeping' } = req.body || {};
  const body = SMS_TEMPLATES[template];
  if (!body) return res.status(400).json({ error: 'Unknown SMS template' });
  const result = await pipeline.runPipeline({ message: body, source: 'sms' });
  res.json({ template: { key: template, body }, ...result });
});

router.post('/test/create-ticket', async (req, res) => {
  if (!monday.isConfigured()) {
    return res.status(400).json({ error: 'Monday.com not configured' });
  }
  try {
    const result = await monday.createTicket({
      name: 'TEST Ticket - Arrowhead Intake Agent',
      clientName: 'Test Client',
      address: '123 Test St, Houston, TX',
      workType: 'pressure washing',
      urgency: 'normal',
      originalMessage: 'This is a test ticket created from the Arrowhead Intake Agent dashboard.',
      flag: 'needs_review',
      propertyManager: 'Test Manager',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
