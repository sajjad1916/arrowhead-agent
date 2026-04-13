// Webhook endpoints. Twilio/Gmail are STUBBED in this prototype —
// they log the hit and return OK so production can be wired up later.
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const pipeline = require('../pipeline');
const monday = require('../services/monday');
const cache = require('../services/cache');

// Twilio SMS webhook (stubbed: still runs pipeline)
router.post('/twilio', async (req, res) => {
  const { Body, From, NumMedia } = req.body || {};
  logger.info(`Twilio webhook hit — from=${From}, body="${Body}"`);
  if (!Body) {
    return res.status(400).send('<Response/>');
  }
  try {
    await pipeline.runPipeline({ message: Body, source: 'sms' });
  } catch (err) {
    logger.error('Twilio webhook pipeline error:', err.message);
  }
  // TwiML response (empty means no auto-reply; prototype only)
  res.set('Content-Type', 'text/xml');
  res.send('<Response/>');
});

// Email webhook (stubbed)
router.post('/email', async (req, res) => {
  const { body, from, subject } = req.body || {};
  logger.info(`Email webhook hit — from=${from}, subject="${subject}"`);
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    await pipeline.runPipeline({ message: body, source: 'email' });
  } catch (err) {
    logger.error('Email webhook pipeline error:', err.message);
  }
  res.json({ ok: true });
});

// ---------- Monday.com Properties webhook ----------
// Monday pushes events here whenever a row on the Properties board is
// created, edited, or deleted. We update the local cache in response so
// the agent always sees the current property list without a human ever
// having to click "Refresh cache" in the UI.
//
// First request from Monday contains a `challenge` field — we must echo it
// back verbatim for the webhook to be verified and activated.

// Short-lived idempotency guard. Monday occasionally re-delivers events;
// we dedupe by a cheap hash of (eventType, pulseId, columnId, updatedAt).
const recentEventKeys = new Map();
const EVENT_DEDUPE_WINDOW_MS = 60 * 1000;

function seenRecently(key) {
  const now = Date.now();
  // Sweep expired entries opportunistically
  for (const [k, t] of recentEventKeys) {
    if (now - t > EVENT_DEDUPE_WINDOW_MS) recentEventKeys.delete(k);
  }
  if (recentEventKeys.has(key)) return true;
  recentEventKeys.set(key, now);
  return false;
}

router.post('/monday-properties', async (req, res) => {
  const body = req.body || {};

  // 1. Handshake — Monday sends this when you first register the webhook.
  if (body.challenge) {
    logger.info('Monday webhook handshake received.');
    return res.json({ challenge: body.challenge });
  }

  const event = body.event || {};
  const eventType = event.type;
  const pulseId = event.pulseId || event.itemId;

  // Respond fast — Monday retries if we don't ack within a few seconds.
  res.json({ ok: true });

  // Everything below is fire-and-forget relative to the HTTP response.
  try {
    cache.touchWebhook();

    const dedupeKey = `${eventType}:${pulseId}:${event.columnId || ''}:${event.updateTime || ''}`;
    if (seenRecently(dedupeKey)) {
      logger.info(`Monday webhook duplicate ignored (${dedupeKey}).`);
      return;
    }

    logger.info(`Monday webhook: ${eventType} pulse=${pulseId || '—'}`);

    if (!monday.isConfigured()) {
      logger.warn('Monday webhook received but MONDAY_API_KEY not set — cannot reconcile.');
      return;
    }

    switch (eventType) {
      case 'create_pulse':
      case 'update_column_value':
      case 'change_column_value':
      case 'change_name': {
        // Pull the authoritative row from Monday and upsert it.
        if (!pulseId) return;
        const prop = await monday.fetchPropertyById(pulseId);
        if (prop) {
          cache.upsertProperty(prop);
          logger.info(`Property cache upserted: ${prop.name} (${prop.id})`);
        } else {
          logger.warn(`Webhook event for pulse ${pulseId} but fetchPropertyById returned null.`);
        }
        return;
      }

      case 'item_deleted':
      case 'delete_pulse': {
        if (!pulseId) return;
        cache.removeProperty(pulseId);
        return;
      }

      default:
        // Ignore other event types (subitem moves, column_metadata changes, etc.)
        logger.info(`Ignoring Monday event type: ${eventType}`);
    }
  } catch (err) {
    logger.error('Monday webhook handler error:', err.message);
  }
});

module.exports = router;
