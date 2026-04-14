// Assignment logic: returning-customer CSR lookup → escalation → default fallback.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'assignment-config.json');
const TICKETS_LOG_PATH = path.join(__dirname, '..', '..', 'data', 'tickets-log.json');

const DEFAULT_CONFIG = {
  default_assignee: 'CD-Nathan',
  escalation_to: 'CD-Nathan',
  escalation_keywords: ['large project', 'sensitive', 'emergency', 'over $10k'],
};

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
}

function readConfig() {
  ensureConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Migrate old configs that still have team_members / current_index
    if (!raw.default_assignee) {
      raw.default_assignee = raw.escalation_to || DEFAULT_CONFIG.default_assignee;
    }
    return raw;
  } catch (err) {
    logger.error('Failed reading assignment config, resetting:', err.message);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function shouldEscalate(message, urgency, keywords) {
  if (urgency === 'asap') return true;
  if (!message) return false;
  const lower = message.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

// Search local ticket history for a returning client and return the CSR
// who last handled their ticket. This gives returning customers continuity.
function lookupReturningCSR(clientName) {
  if (!clientName) return null;
  try {
    if (!fs.existsSync(TICKETS_LOG_PATH)) return null;
    const tickets = JSON.parse(fs.readFileSync(TICKETS_LOG_PATH, 'utf8'));
    const needle = clientName.toLowerCase();
    // Search newest-first (array is already newest-first)
    for (const t of tickets) {
      if (!t.client_name || !t.assigned_to) continue;
      if (t.client_name.toLowerCase().includes(needle) || needle.includes(t.client_name.toLowerCase())) {
        logger.info(`Returning customer "${clientName}" — previous CSR: ${t.assigned_to}`);
        return t.assigned_to;
      }
    }
  } catch (err) {
    logger.warn('lookupReturningCSR failed:', err.message);
  }
  return null;
}

function assign({ message, urgency, clientName }) {
  const config = readConfig();

  // 1. Escalation — ASAP urgency or keyword match
  if (shouldEscalate(message, urgency, config.escalation_keywords)) {
    return { assignedTo: config.escalation_to, escalated: true };
  }

  // 2. Returning customer — look up previous CSR from ticket history
  const previousCSR = lookupReturningCSR(clientName);
  if (previousCSR) {
    return { assignedTo: previousCSR, escalated: false, returning: true };
  }

  // 3. Default fallback — Nathan
  const fallback = config.default_assignee || DEFAULT_CONFIG.default_assignee;
  if (fallback) {
    return { assignedTo: fallback, escalated: false };
  }

  return { assignedTo: null, escalated: false, needsAssignment: true };
}

module.exports = { assign, readConfig, writeConfig, ensureConfig, DEFAULT_CONFIG, lookupReturningCSR };
