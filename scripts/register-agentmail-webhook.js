#!/usr/bin/env node
// Register an AgentMail webhook to receive incoming emails.
// Usage: node scripts/register-agentmail-webhook.js <YOUR_PUBLIC_URL>
// Example: node scripts/register-agentmail-webhook.js https://abc123.ngrok-free.app

require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.AGENTMAIL_API_KEY;
const PUBLIC_URL = process.argv[2];

if (!API_KEY) {
  console.error('Error: AGENTMAIL_API_KEY not set in .env');
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error('Usage: node scripts/register-agentmail-webhook.js <YOUR_PUBLIC_URL>');
  console.error('Example: node scripts/register-agentmail-webhook.js https://your-app.up.railway.app');
  process.exit(1);
}

const webhookUrl = PUBLIC_URL.replace(/\/$/, '') + '/webhooks/agentmail';

async function main() {
  console.log(`Registering AgentMail webhook...`);
  console.log(`  URL: ${webhookUrl}`);
  console.log(`  Events: message.received`);
  console.log('');

  const res = await fetch('https://api.agentmail.to/v0/webhooks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: webhookUrl,
      event_types: ['message.received'],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('Failed to register webhook:', res.status, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('Webhook registered successfully!');
  console.log(`  Webhook ID: ${data.webhook_id || data.id}`);
  console.log(`  Secret: ${data.secret || '(none)'}`);
  console.log('');
  console.log('Now send an email to arrowhead@agentmail.to — it will be processed by the agent.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
