const express = require('express');
const path = require('path');
const router = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

router.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

module.exports = router;
