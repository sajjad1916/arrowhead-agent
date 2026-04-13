// Property cache management. Refreshes from Monday.com on startup and every 6 hours.
const fs = require('fs');
const path = require('path');
const monday = require('./monday');
const logger = require('../utils/logger');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'property-cache.json');
// Safety-net timer. Webhooks (see src/routes/webhooks.js) keep the cache fresh in
// near-real-time; this poll is just a belt-and-braces floor if webhooks ever break.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// If we haven't received a webhook in this long, treat the webhook as unhealthy
// and surface it to the UI so someone can re-register it.
const WEBHOOK_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Seed data used when Monday.com is not yet connected. Enables demo/testing.
const SEED_PROPERTIES = [
  { id: 's1', name: 'Sterling Plaza Shopping Center', client_name: 'Greystar Property Management', address: '8350 Westheimer Rd, Houston, TX 77063', property_manager: 'Nathan Torres', manager_phone: '(713) 555-0101', manager_email: 'ntorres@greystar.com' },
  { id: 's2', name: 'Sterling Place Apartments', client_name: 'Greystar Property Management', address: '4200 Sterling Place Dr, Houston, TX 77056', property_manager: 'Nathan Torres', manager_phone: '(713) 555-0101', manager_email: 'ntorres@greystar.com' },
  { id: 's3', name: 'Lakeside Corporate Park', client_name: 'Lakeside Properties', address: '1200 Lakeside Blvd, Houston, TX 77042', property_manager: 'David Kim', manager_phone: '(713) 555-0202', manager_email: 'dkim@lakesideproperties.com' },
  { id: 's4', name: 'Energy Corridor Tower', client_name: 'Hines', address: '15800 Memorial Dr, Houston, TX 77079', property_manager: 'Roberto Alvarez', manager_phone: '(713) 555-0303', manager_email: 'ralvarez@hines.com' },
  { id: 's5', name: 'Post Oak Central', client_name: 'Hines', address: '1980 Post Oak Blvd, Houston, TX 77056', property_manager: 'Michael Chang', manager_phone: '(713) 555-0304', manager_email: 'mchang@hines.com' },
  { id: 's6', name: 'Galleria Professional Center', client_name: 'JLL', address: '5075 Westheimer Rd, Houston, TX 77056', property_manager: 'Karen Rodriguez', manager_phone: '(713) 555-0404', manager_email: 'krodriguez@jll.com' },
  { id: 's7', name: 'Westfield Business Park', client_name: 'JLL', address: '10350 Westfield Rd, Houston, TX 77073', property_manager: 'Karen Rodriguez', manager_phone: '(713) 555-0404', manager_email: 'krodriguez@jll.com' },
  { id: 's8', name: 'Cypress Mill Plaza', client_name: 'CBRE', address: '12800 Cypress N Houston Rd, Cypress, TX 77429', property_manager: 'Alicia Park', manager_phone: '(713) 555-0505', manager_email: 'apark@cbre.com' },
  { id: 's9', name: 'Memorial Heights Tower', client_name: 'CBRE', address: '1800 W Loop S, Houston, TX 77027', property_manager: 'Alicia Park', manager_phone: '(713) 555-0505', manager_email: 'apark@cbre.com' },
  { id: 's10', name: 'Richmond Commons', client_name: 'CBRE', address: '5959 Richmond Ave, Houston, TX 77057', property_manager: 'Alicia Park', manager_phone: '(713) 555-0505', manager_email: 'apark@cbre.com' },
  { id: 's11', name: 'Hines Building I', client_name: 'Hines', address: '600 Travis St, Houston, TX 77002', property_manager: 'Michael Chang', manager_phone: '(713) 555-0304', manager_email: 'mchang@hines.com' },
  { id: 's12', name: 'Hines Building II', client_name: 'Hines', address: '700 Louisiana St, Houston, TX 77002', property_manager: 'Michael Chang', manager_phone: '(713) 555-0304', manager_email: 'mchang@hines.com' },
  { id: 's13', name: 'Hines Building III', client_name: 'Hines', address: '800 Bell St, Houston, TX 77002', property_manager: 'Michael Chang', manager_phone: '(713) 555-0304', manager_email: 'mchang@hines.com' },
  { id: 's14', name: 'Hines Building IV', client_name: 'Hines', address: '900 Main St, Houston, TX 77002', property_manager: 'Michael Chang', manager_phone: '(713) 555-0304', manager_email: 'mchang@hines.com' },
  { id: 's15', name: 'Greystar River Oaks', client_name: 'Greystar Property Management', address: '2200 River Oaks Blvd, Houston, TX 77019', property_manager: 'Nathan Torres', manager_phone: '(713) 555-0101', manager_email: 'ntorres@greystar.com' },
  { id: 's16', name: 'Greystar Medical Center', client_name: 'Greystar Property Management', address: '6700 Fannin St, Houston, TX 77030', property_manager: 'Nathan Torres', manager_phone: '(713) 555-0101', manager_email: 'ntorres@greystar.com' },
  { id: 's17', name: 'Lakeside II', client_name: 'Lakeside Properties', address: '1400 Lakeside Blvd, Houston, TX 77042', property_manager: 'David Kim', manager_phone: '(713) 555-0202', manager_email: 'dkim@lakesideproperties.com' },
  { id: 's18', name: 'Lakeside III', client_name: 'Lakeside Properties', address: '1600 Lakeside Blvd, Houston, TX 77042', property_manager: 'David Kim', manager_phone: '(713) 555-0202', manager_email: 'dkim@lakesideproperties.com' },
  { id: 's19', name: 'Bayou Properties Complex', client_name: 'Bayou Properties', address: '4500 Richmond Ave, Houston, TX 77027', property_manager: 'Sarah Johnson', manager_phone: '(713) 555-0606', manager_email: 'sjohnson@bayouprop.com' },
  { id: 's20', name: 'JLL Downtown Tower', client_name: 'JLL', address: '1100 Louisiana St, Houston, TX 77002', property_manager: 'Karen Rodriguez', manager_phone: '(713) 555-0404', manager_email: 'krodriguez@jll.com' },
];

let refreshTimer = null;

function defaultSeed() {
  return {
    updated_at: new Date().toISOString(),
    source: 'seed',
    last_webhook_at: null,
    properties: SEED_PROPERTIES,
  };
}

function readCache() {
  if (!fs.existsSync(CACHE_PATH)) {
    const seeded = defaultSeed();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    // Back-compat for older cache files without last_webhook_at
    if (!('last_webhook_at' in parsed)) parsed.last_webhook_at = null;
    return parsed;
  } catch (err) {
    logger.error('Failed reading property cache, reseeding:', err.message);
    const seeded = defaultSeed();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(seeded, null, 2));
    return seeded;
  }
}

function writeCache(properties, source, extra = {}) {
  const prev = fs.existsSync(CACHE_PATH) ? readCache() : {};
  const payload = {
    updated_at: new Date().toISOString(),
    source,
    last_webhook_at: extra.last_webhook_at ?? prev.last_webhook_at ?? null,
    properties,
  };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

// Insert-or-update a single property by ID. Called from the Monday webhook
// handler when a property is created or edited on the board.
function upsertProperty(prop) {
  if (!prop || !prop.id) return null;
  const current = readCache();
  const next = current.properties.filter((p) => String(p.id) !== String(prop.id));
  next.push(prop);
  // Keep stable order by name so the UI doesn't jump around.
  next.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const payload = {
    updated_at: new Date().toISOString(),
    source: 'webhook',
    last_webhook_at: new Date().toISOString(),
    properties: next,
  };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

// Delete one property by ID. Called from the Monday webhook handler
// when a property is removed from the board.
function removeProperty(id) {
  if (!id) return null;
  const current = readCache();
  const before = current.properties.length;
  const next = current.properties.filter((p) => String(p.id) !== String(id));
  const payload = {
    updated_at: new Date().toISOString(),
    source: 'webhook',
    last_webhook_at: new Date().toISOString(),
    properties: next,
  };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
  logger.info(`Property ${id} removed via webhook (${before} → ${next.length}).`);
  return payload;
}

// Record that we received *some* webhook ping, even if it didn't mutate state
// (e.g. column change we don't care about). Used for health monitoring.
function touchWebhook() {
  const current = readCache();
  current.last_webhook_at = new Date().toISOString();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(current, null, 2));
}

// Summary for the dashboard's cache-health badge.
function getStatus() {
  const c = readCache();
  const ageMs = Date.now() - new Date(c.updated_at).getTime();
  const lastWebhookMs = c.last_webhook_at ? Date.now() - new Date(c.last_webhook_at).getTime() : null;
  return {
    updated_at: c.updated_at,
    source: c.source,
    property_count: c.properties.length,
    last_webhook_at: c.last_webhook_at,
    age_ms: ageMs,
    last_webhook_ms: lastWebhookMs,
    webhook_healthy: lastWebhookMs !== null && lastWebhookMs < WEBHOOK_STALE_MS,
    webhook_ever_received: c.last_webhook_at !== null,
  };
}

async function refresh() {
  if (!monday.isConfigured()) {
    logger.info('Monday not configured — using seed properties for cache.');
    return readCache();
  }
  try {
    const properties = await monday.fetchProperties();
    if (!properties || properties.length === 0) {
      logger.warn('Monday returned zero properties — keeping existing cache.');
      return readCache();
    }
    const payload = writeCache(properties, 'monday');
    logger.info(`Property cache refreshed: ${properties.length} properties from Monday.com`);
    return payload;
  } catch (err) {
    logger.error('Property cache refresh failed:', err.message);
    return readCache();
  }
}

function getProperties() {
  return readCache().properties;
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refresh().catch((err) => logger.error('Auto-refresh error:', err.message));
  }, REFRESH_INTERVAL_MS);
}

module.exports = {
  readCache,
  writeCache,
  refresh,
  getProperties,
  startAutoRefresh,
  upsertProperty,
  removeProperty,
  touchWebhook,
  getStatus,
  SEED_PROPERTIES,
};
