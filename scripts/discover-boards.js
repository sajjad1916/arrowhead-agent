#!/usr/bin/env node
// One-time diagnostic: lists every Monday.com board the configured API
// key can see. Useful for setup when you don't have the board IDs —
// the client only has to hand over MONDAY_API_KEY.
//
// Usage:   node scripts/discover-boards.js
// Requires: MONDAY_API_KEY in env (or .env)

require('dotenv').config();
const monday = require('../src/services/monday');

(async () => {
  if (!monday.isConfigured()) {
    console.error('✗ MONDAY_API_KEY is not set. Add it to .env and try again.');
    process.exit(1);
  }

  try {
    const boards = await monday.discoverBoards();
    if (!boards.length) {
      console.log('No boards visible to this API key.');
      console.log('The key may be scoped to a workspace the user has no boards in,');
      console.log('or the user hasn\'t been invited to any boards yet.');
      process.exit(0);
    }

    console.log('');
    console.log('Boards visible to this API key:');
    console.log('─'.repeat(72));
    console.log('ID'.padEnd(14) + 'Items'.padEnd(8) + 'Name');
    console.log('─'.repeat(72));
    for (const b of boards) {
      const id = String(b.id).padEnd(14);
      const count = String(b.items_count ?? '—').padEnd(8);
      console.log(id + count + (b.name || '(unnamed)'));
    }
    console.log('─'.repeat(72));
    console.log('');
    console.log('Likely Property board (name match):');
    const propertyCandidates = boards.filter((b) => /propert/i.test(b.name || ''));
    if (propertyCandidates.length) {
      for (const b of propertyCandidates) console.log(`  → ${b.id}  ${b.name}`);
    } else {
      console.log('  (none found — look for a board with client/address columns)');
    }
    console.log('');
    console.log('Set MONDAY_PROPERTY_BOARD_ID in .env to lock in the right board.');
  } catch (err) {
    console.error('✗ Failed to list boards:', err.message);
    process.exit(1);
  }
})();
