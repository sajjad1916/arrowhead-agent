// Round-robin assigner with escalation rules.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'assignment-config.json');

const DEFAULT_CONFIG = {
  team_members: ['CSR-Jana', 'CSR-Casey', 'CSM-Maria'],
  current_index: 0,
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
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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

function assign({ message, urgency }) {
  const config = readConfig();
  if (shouldEscalate(message, urgency, config.escalation_keywords)) {
    return { assignedTo: config.escalation_to, escalated: true };
  }
  if (!config.team_members || config.team_members.length === 0) {
    return { assignedTo: null, escalated: false, needsAssignment: true };
  }
  const idx = config.current_index % config.team_members.length;
  const member = config.team_members[idx];
  config.current_index = (idx + 1) % config.team_members.length;
  writeConfig(config);
  return { assignedTo: member, escalated: false };
}

module.exports = { assign, readConfig, writeConfig, ensureConfig, DEFAULT_CONFIG };
