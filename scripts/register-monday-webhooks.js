#!/usr/bin/env node
// One-time setup: registers the Monday.com webhooks that keep the property
// cache in sync without any manual "Refresh cache" clicks.
//
// Usage:
//   MONDAY_WEBHOOK_PUBLIC_URL=https://your-app.vercel.app \
//     node scripts/register-monday-webhooks.js
//
// Or rely on .env for both MONDAY_API_KEY and MONDAY_WEBHOOK_PUBLIC_URL.
//
// Safe to re-run — it lists existing webhooks first and skips events that
// are already registered against the same URL.

require('dotenv').config();
const monday = require('../src/services/monday');

const EVENTS_TO_REGISTER = [
  'create_pulse',          // new property added to the board
  'change_column_value',   // any column edited (client, address, manager, etc.)
  'change_name',           // property renamed
  'item_deleted',          // property removed
];

(async () => {
  if (!monday.isConfigured()) {
    console.error('✗ MONDAY_API_KEY is not set.');
    process.exit(1);
  }

  const publicUrl = process.env.MONDAY_WEBHOOK_PUBLIC_URL;
  if (!publicUrl) {
    console.error('✗ MONDAY_WEBHOOK_PUBLIC_URL is not set.');
    console.error('  Set it to the public base URL of the server, e.g.');
    console.error('    MONDAY_WEBHOOK_PUBLIC_URL=https://arrowhead-intake.vercel.app');
    process.exit(1);
  }

  const webhookUrl = publicUrl.replace(/\/+$/, '') + '/webhooks/monday-properties';
  const boardId = monday.getPropertyBoardId();

  console.log('');
  console.log(`Target board:  ${boardId}`);
  console.log(`Webhook URL:   ${webhookUrl}`);
  console.log('');

  // Show what's already registered so the user can see the state.
  let existing = [];
  try {
    existing = await monday.listWebhooks(boardId);
  } catch (err) {
    console.error('✗ Could not list existing webhooks:', err.message);
    console.error('  Check that MONDAY_API_KEY has webhooks:read scope.');
    process.exit(1);
  }

  console.log(`Existing webhooks on board: ${existing.length}`);
  for (const w of existing) {
    console.log(`  · id=${w.id}  event=${w.event}`);
  }
  console.log('');

  const alreadyRegistered = new Set(existing.map((w) => w.event));

  for (const event of EVENTS_TO_REGISTER) {
    if (alreadyRegistered.has(event)) {
      console.log(`  ✓ already registered: ${event}`);
      continue;
    }
    try {
      const result = await monday.registerWebhook({ boardId, url: webhookUrl, event });
      console.log(`  + registered ${event} → id=${result?.id}`);
    } catch (err) {
      console.error(`  ✗ failed to register ${event}:`, err.message);
    }
  }

  console.log('');
  console.log('Done. Edit a property on the board to confirm — you should see');
  console.log('the cache-health badge on /properties flip to "Live" within seconds.');
})();
