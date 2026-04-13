const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

router.get('/login-hint', (req, res) => {
  const a = auth.readAuth();
  res.json({ username: a.username, password: a.password });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const a = auth.readAuth();
  if (username === a.username && password === a.password) {
    const token = auth.createSession();
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/logout', auth.requireAuth, (req, res) => {
  auth.destroySession(req.sessionToken);
  res.json({ ok: true });
});

router.post('/regenerate-password', auth.requireAuth, (req, res) => {
  const updated = auth.regeneratePassword();
  res.json({ username: updated.username, password: updated.password });
});

module.exports = router;
