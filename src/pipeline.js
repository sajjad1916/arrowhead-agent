// Main intake pipeline: receive → parse → match → assign → create → log.
// Returns a step-by-step trace so the dashboard can render the live visualization.
const fs = require('fs');
const path = require('path');
const parser = require('./services/parser');
const matcher = require('./services/property-matcher');
const assigner = require('./services/assigner');
const monday = require('./services/monday');
const cache = require('./services/cache');
const { cleanForwardedEmail } = require('./utils/email-parser');
const logger = require('./utils/logger');

const TICKETS_LOG_PATH = path.join(__dirname, '..', 'data', 'tickets-log.json');
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

function isDemoMode() {
  if (!fs.existsSync(SETTINGS_PATH)) return false;
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return s.demo_mode === true;
  } catch { return false; }
}

function readTickets() {
  if (!fs.existsSync(TICKETS_LOG_PATH)) {
    fs.writeFileSync(TICKETS_LOG_PATH, '[]');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(TICKETS_LOG_PATH, 'utf8'));
  } catch (err) {
    logger.error('Failed reading tickets log, resetting:', err.message);
    fs.writeFileSync(TICKETS_LOG_PATH, '[]');
    return [];
  }
}

function appendTicket(ticket) {
  const tickets = readTickets();
  tickets.unshift(ticket); // newest first
  fs.writeFileSync(TICKETS_LOG_PATH, JSON.stringify(tickets, null, 2));
}

function clearTickets() {
  fs.writeFileSync(TICKETS_LOG_PATH, '[]');
}

function titleCase(s) {
  if (!s) return '';
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function buildTicketName({ workType, match, propertyReference }) {
  const wt = titleCase(workType || 'General Request');
  let loc = match?.name || propertyReference || 'Unknown Property';
  return `${wt} - ${loc}`;
}

// Runs the full pipeline on a message. Returns a trace object.
async function runPipeline({ message, source }) {
  const steps = [];
  const startedAt = new Date().toISOString();
  logger.info(`Pipeline start — source=${source}, len=${message?.length}`);

  // Step 1: Message Received
  const cleanedMessage = source === 'email' ? cleanForwardedEmail(message) : message;
  steps.push({
    key: 'received',
    title: 'Message Received',
    icon: '📥',
    status: 'success',
    data: {
      source,
      raw: message,
      cleaned: cleanedMessage,
      length: cleanedMessage.length,
    },
  });

  // Step 2: AI Parsing
  let parsed = null;
  let parseSource = 'mock';
  try {
    const result = await parser.parse(cleanedMessage);
    parsed = result.parsed;
    parseSource = result.source;
    steps.push({
      key: 'parse',
      title: 'AI Parsing',
      icon: '🧠',
      status: 'success',
      data: { parsed, parser: parseSource },
    });
  } catch (err) {
    logger.error('Parse error:', err.message);
    parsed = {
      client_name: null,
      property_reference: null,
      work_type: null,
      urgency: 'normal',
      additional_context: null,
      forwarder_context: null,
    };
    steps.push({
      key: 'parse',
      title: 'AI Parsing',
      icon: '🧠',
      status: 'warning',
      data: { parsed, parser: 'fallback', error: err.message },
    });
  }

  // Step 3: Property Lookup
  // Cache-first, with a live Monday fallback on a complete miss. This closes
  // the window between "property added in Monday" and "webhook/refresh fires"
  // so the agent doesn't spuriously flag `location_not_found`.
  const properties = cache.getProperties();
  const matchResult = await matcher.matchPropertyWithFallback(
    parsed.property_reference,
    properties,
    { monday, cache }
  );
  let flag = 'ok';
  if (!matchResult.match) flag = 'location_not_found';
  if (matchResult.ambiguous) flag = 'needs_review';

  steps.push({
    key: 'match',
    title: 'Property Lookup',
    icon: '🔍',
    status: matchResult.match ? (matchResult.ambiguous ? 'warning' : 'success') : 'warning',
    data: {
      reference: parsed.property_reference,
      match: matchResult.match,
      matchType: matchResult.matchType,
      score: matchResult.score,
      alternatives: matchResult.alternatives || [],
      liveFallback: matchResult.liveFallback === true,
    },
  });

  // Step 4: Assignment
  const assignResult = assigner.assign({
    message: cleanedMessage,
    urgency: parsed.urgency,
  });
  if (assignResult.needsAssignment) flag = 'needs_assignment';

  steps.push({
    key: 'assign',
    title: 'Assignment',
    icon: '👤',
    status: assignResult.assignedTo ? 'success' : 'warning',
    data: {
      assignedTo: assignResult.assignedTo,
      escalated: assignResult.escalated,
    },
  });

  // Step 5: Build + Create Ticket
  const ticketName = buildTicketName({
    workType: parsed.work_type,
    match: matchResult.match,
    propertyReference: parsed.property_reference,
  });

  let originalMessageField = cleanedMessage;
  if (matchResult.alternatives?.length > 0) {
    originalMessageField += `\n\n---\nNote: Multiple property matches found — ${matchResult.alternatives.join(', ')}. Agent selected ${matchResult.match?.name}. Please verify.`;
  }

  const ticketData = {
    name: ticketName,
    clientName: matchResult.match?.client_name || parsed.client_name || '',
    address: matchResult.match?.address || '',
    workType: parsed.work_type || '',
    urgency: parsed.urgency || 'normal',
    originalMessage: originalMessageField,
    flag,
    propertyManager: matchResult.match?.property_manager || '',
  };

  let creationStep = {
    key: 'create',
    title: 'Creating Monday.com Ticket',
    icon: '📋',
    status: 'success',
    data: { preview: ticketData },
  };

  let ticketId = null;
  let ticketUrl = null;
  let simulated = false;

  const demoMode = isDemoMode();
  if (demoMode) {
    ticketId = `sim-${Date.now()}`;
    simulated = true;
    creationStep.data.simulated = true;
    creationStep.data.ticketId = ticketId;
    creationStep.data.note = 'Demo mode is ON — ticket simulated, not sent to Monday.';
  } else if (monday.isConfigured()) {
    try {
      const res = await monday.createTicket(ticketData);
      ticketId = res.id;
      ticketUrl = res.url;
      creationStep.data.ticketId = ticketId;
      creationStep.data.ticketUrl = ticketUrl;
      creationStep.data.simulated = false;
    } catch (err) {
      logger.error('Monday createTicket failed:', err.message);
      creationStep.status = 'error';
      creationStep.data.error = err.message;
      ticketId = `sim-${Date.now()}`;
      simulated = true;
      creationStep.data.simulated = true;
    }
  } else {
    ticketId = `sim-${Date.now()}`;
    simulated = true;
    creationStep.data.simulated = true;
    creationStep.data.ticketId = ticketId;
    creationStep.data.note = 'Monday.com not connected — ticket simulated only.';
  }
  steps.push(creationStep);

  // Step 6: Complete
  steps.push({
    key: 'complete',
    title: 'Complete',
    icon: '✅',
    status: 'success',
    data: {
      ticketId,
      ticketUrl,
      simulated,
      confirmationMessage: buildConfirmationMessage({
        workType: parsed.work_type,
        property: matchResult.match?.name || parsed.property_reference,
        assignedTo: assignResult.assignedTo,
        flag,
      }),
    },
  });

  // Log the ticket locally
  const ticketRecord = {
    id: ticketId,
    created_at: startedAt,
    source,
    ticket_name: ticketName,
    client_name: ticketData.clientName,
    property: matchResult.match?.name || parsed.property_reference || null,
    address: ticketData.address,
    work_type: ticketData.workType,
    urgency: ticketData.urgency,
    assigned_to: assignResult.assignedTo,
    flag,
    simulated,
    monday_url: ticketUrl,
    raw_message: message,
    parsed,
    parser_source: parseSource,
  };
  appendTicket(ticketRecord);

  logger.info(`Pipeline done — ticket=${ticketId}, flag=${flag}, property=${matchResult.match?.name || 'none'}`);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    ticket: ticketRecord,
  };
}

function buildConfirmationMessage({ workType, property, assignedTo, flag }) {
  if (flag !== 'ok') {
    return `✓ Ticket created and flagged for review. We captured your message.`;
  }
  const wt = titleCase(workType || 'request');
  return `✓ Created ticket for ${wt} at ${property} — assigned to ${assignedTo}. Ticket on board.`;
}

module.exports = {
  runPipeline,
  readTickets,
  clearTickets,
};
