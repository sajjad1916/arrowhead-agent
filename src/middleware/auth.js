const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_PATH = path.join(__dirname, '..', '..', 'data', 'auth.json');
const SESSIONS_PATH = path.join(__dirname, '..', '..', 'data', 'sessions.json');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function ensureAuth() {
  if (!fs.existsSync(AUTH_PATH)) {
    const creds = {
      username: 'arrowhead-admin',
      password: randomPassword(),
      generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(AUTH_PATH, JSON.stringify(creds, null, 2));
  }
  if (!fs.existsSync(SESSIONS_PATH)) {
    fs.writeFileSync(SESSIONS_PATH, '{}');
  }
}

function readAuth() {
  ensureAuth();
  return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
}

function readSessions() {
  ensureAuth();
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSessions(sessions) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  const sessions = readSessions();
  sessions[token] = { created_at: Date.now(), expires_at: Date.now() + SESSION_TTL_MS };
  writeSessions(sessions);
  return token;
}

function destroySession(token) {
  const sessions = readSessions();
  delete sessions[token];
  writeSessions(sessions);
}

function validateSession(token) {
  if (!token) return false;
  const sessions = readSessions();
  const s = sessions[token];
  if (!s) return false;
  if (Date.now() > s.expires_at) {
    delete sessions[token];
    writeSessions(sessions);
    return false;
  }
  return true;
}

function regeneratePassword() {
  const auth = readAuth();
  auth.password = randomPassword();
  auth.generated_at = new Date().toISOString();
  fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
  return auth;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!validateSession(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.sessionToken = token;
  next();
}

module.exports = {
  ensureAuth,
  readAuth,
  createSession,
  destroySession,
  validateSession,
  regeneratePassword,
  requireAuth,
};
