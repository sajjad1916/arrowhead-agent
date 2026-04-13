// Arrowhead Intake Agent — Express entry point
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const logger = require('./src/utils/logger');
const authMiddleware = require('./src/middleware/auth');
const authRoutes = require('./src/routes/auth');
const apiRoutes = require('./src/routes/api');
const webhookRoutes = require('./src/routes/webhooks');
const dashboardRoutes = require('./src/routes/dashboard');
const cache = require('./src/services/cache');
const assigner = require('./src/services/assigner');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Bootstrap data dir ----------
function bootstrapDataDir() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  authMiddleware.ensureAuth();
  assigner.ensureConfig();
  // Warm property cache (seed if no Monday key)
  cache.refresh().catch((err) => logger.error('Initial cache refresh failed:', err.message));
  cache.startAutoRefresh();
}

// ---------- Middleware ----------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Static assets
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Routes
app.use('/api', authRoutes); // login + login-hint + logout
app.use('/api', apiRoutes); // dashboard API (all auth-gated inside)
app.use('/webhooks', webhookRoutes);
app.use('/', dashboardRoutes);

// Generic error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// ---------- Start ----------
bootstrapDataDir();
app.listen(PORT, () => {
  const auth = authMiddleware.readAuth();
  logger.info('');
  logger.info('╔════════════════════════════════════════════════════╗');
  logger.info(`║  Arrowhead Intake Agent listening on :${PORT}         ║`);
  logger.info('╠════════════════════════════════════════════════════╣');
  logger.info(`║  URL:      http://localhost:${PORT}                   ║`);
  logger.info(`║  Username: ${auth.username.padEnd(40)}║`);
  logger.info(`║  Password: ${auth.password.padEnd(40)}║`);
  logger.info('╚════════════════════════════════════════════════════╝');
  logger.info('');
});
