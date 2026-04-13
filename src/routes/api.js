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

const DEFAULT_SETTINGS = {
  demo_mode: true,
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
  res.json({ settings, connections });
});

router.put('/settings', (req, res) => {
  const current = readSettings();
  const next = { ...current, ...req.body };
  writeSettings(next);
  res.json(next);
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
