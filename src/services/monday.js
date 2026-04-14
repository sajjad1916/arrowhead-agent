// Monday.com GraphQL client.
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const API_URL = 'https://api.monday.com/v2';
const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'settings.json');

// Default column mappings — used when no UI override is saved
const DEFAULT_COLS = {
  quotes: {
    stage: 'color_mm2a4vwv',
    client_name: 'text_mm2ajm0p',
    address: 'text_mm2armcf',
    work_type: 'text_mm2a7f7h',
    urgency: 'color_mm2an1jw',
    original_message: 'long_text_mm2a93g1',
    flag: 'color_mm2a3891',
    property_manager: 'text_mm2amygs',
  },
  properties: {
    client_name: 'text_mm2a8taj',
    address: 'text_mm2a55jx',
    property_manager: 'text_mm2asbct',
    manager_phone: 'text_mm2a9rjz',
    manager_email: 'email_mm2arjcm',
  },
};

// Live accessor — reads settings each call so UI saves take effect immediately
function _readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch { return {}; }
}

// COLS is a getter so column overrides from settings are picked up
const COLS = new Proxy(DEFAULT_COLS, {
  get(target, prop) {
    const s = _readSettings();
    if (prop === 'quotes' && s.monday_cols_quotes) return { ...target.quotes, ...s.monday_cols_quotes };
    if (prop === 'properties' && s.monday_cols_properties) return { ...target.properties, ...s.monday_cols_properties };
    return target[prop];
  },
});

function getKey() {
  // Settings (UI-saved) takes priority, then env var
  const s = _readSettings();
  return s.monday_api_key || process.env.MONDAY_API_KEY;
}

function isConfigured() {
  return !!getKey();
}

async function graphql(query, variables = {}) {
  const key = getKey();
  if (!key) throw new Error('MONDAY_API_KEY not set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: key,
      'API-Version': '2023-10',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    logger.error('Monday GraphQL errors:', JSON.stringify(json.errors));
    throw new Error(`Monday API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function getPropertyBoardId() {
  const s = _readSettings();
  return s.monday_input_board_id || process.env.MONDAY_PROPERTY_BOARD_ID || '5027768585';
}

function getQuotesBoardId() {
  const s = _readSettings();
  return s.monday_output_board_id || process.env.MONDAY_QUOTES_BOARD_ID || '5027768579';
}

function mapPropertyItem(item) {
  const cv = {};
  for (const c of item.column_values) cv[c.id] = c.text;
  return {
    id: item.id,
    name: item.name,
    client_name: cv[COLS.properties.client_name] || '',
    address: cv[COLS.properties.address] || '',
    property_manager: cv[COLS.properties.property_manager] || '',
    manager_phone: cv[COLS.properties.manager_phone] || '',
    manager_email: cv[COLS.properties.manager_email] || '',
  };
}

async function fetchProperties() {
  const boardId = getPropertyBoardId();
  const query = `{
    boards(ids: [${boardId}]) {
      items_page(limit: 500) {
        items {
          id
          name
          column_values { id text }
        }
      }
    }
  }`;
  const data = await graphql(query);
  const items = data.boards?.[0]?.items_page?.items || [];
  return items.map(mapPropertyItem);
}

// Fetch one property by Monday item ID. Used by the webhook upsert path.
async function fetchPropertyById(itemId) {
  if (!itemId) return null;
  const query = `query ($ids: [ID!]) {
    items(ids: $ids) {
      id
      name
      board { id }
      column_values { id text }
    }
  }`;
  const data = await graphql(query, { ids: [String(itemId)] });
  const item = data.items?.[0];
  if (!item) return null;
  // Safety check: only accept items from the configured properties board.
  const propertyBoardId = String(getPropertyBoardId());
  if (item.board?.id && String(item.board.id) !== propertyBoardId) {
    logger.warn(`fetchPropertyById: item ${itemId} is on board ${item.board.id}, expected ${propertyBoardId}`);
    return null;
  }
  return mapPropertyItem(item);
}

// Live fuzzy search the properties board by name/address fragment.
// Used as a fallback when the cache misses — catches the window between
// a property being added in Monday and the next cache refresh/webhook.
async function findPropertyLive(reference) {
  if (!reference) return null;
  const boardId = getPropertyBoardId();
  // No rules API search here — just pull the board and let the matcher handle it.
  // We could narrow with items_page_by_column_values, but name fuzz is most reliable.
  const query = `{
    boards(ids: [${boardId}]) {
      items_page(limit: 500) {
        items {
          id
          name
          column_values { id text }
        }
      }
    }
  }`;
  const data = await graphql(query);
  const items = data.boards?.[0]?.items_page?.items || [];
  return items.map(mapPropertyItem);
}

// ---------- Webhook management ----------

// Register a webhook against a board. `event` is one of:
//   'create_pulse', 'change_column_value', 'item_deleted', 'update_column_value', etc.
async function registerWebhook({ boardId, url, event, config }) {
  const query = `mutation ($boardId: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
    create_webhook(board_id: $boardId, url: $url, event: $event, config: $config) {
      id
      board_id
    }
  }`;
  const variables = {
    boardId: String(boardId),
    url,
    event,
  };
  if (config) variables.config = JSON.stringify(config);
  const data = await graphql(query, variables);
  return data?.create_webhook;
}

async function listWebhooks(boardId) {
  const query = `query ($boardId: ID!) {
    webhooks(board_id: $boardId) { id event board_id config }
  }`;
  const data = await graphql(query, { boardId: String(boardId) });
  return data?.webhooks || [];
}

async function deleteWebhook(webhookId) {
  const query = `mutation ($id: ID!) {
    delete_webhook(id: $id) { id }
  }`;
  const data = await graphql(query, { id: String(webhookId) });
  return data?.delete_webhook;
}

// Discover all boards visible to the API key — used for one-time setup
// when the client hasn't told us the property board ID.
async function discoverBoards() {
  const query = `{
    boards(limit: 100) {
      id
      name
      description
      items_count
    }
  }`;
  const data = await graphql(query);
  return data?.boards || [];
}

// urgency: "normal"|"urgent"|"asap"
function urgencyIndex(urgency) {
  switch ((urgency || 'normal').toLowerCase()) {
    case 'asap': return 2;
    case 'urgent': return 1;
    default: return 0;
  }
}

// flag: "ok"|"location_not_found"|"needs_review"|"needs_assignment"
function flagIndex(flag) {
  switch (flag) {
    case 'needs_review': return 0;
    case 'location_not_found': return 1;
    case 'needs_assignment': return 2;
    case 'ok':
    default: return 3;
  }
}

async function createTicket({
  name,
  clientName,
  address,
  workType,
  urgency,
  originalMessage,
  flag,
  propertyManager,
}) {
  const boardId = getQuotesBoardId();
  const columnValues = {
    [COLS.quotes.stage]: { index: 0 },
    [COLS.quotes.client_name]: clientName || '',
    [COLS.quotes.address]: address || '',
    [COLS.quotes.work_type]: workType || '',
    [COLS.quotes.urgency]: { index: urgencyIndex(urgency) },
    [COLS.quotes.original_message]: { text: originalMessage || '' },
    [COLS.quotes.flag]: { index: flagIndex(flag) },
    [COLS.quotes.property_manager]: propertyManager || '',
  };

  const query = `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
    create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
      id
    }
  }`;
  const variables = {
    boardId: String(boardId),
    itemName: name,
    columnValues: JSON.stringify(columnValues),
  };
  const data = await graphql(query, variables);
  const id = data?.create_item?.id;
  const url = id ? `https://getsagan-company.monday.com/boards/${boardId}/pulses/${id}` : null;
  return { id, url };
}

// Count items on the Quotes board that are still at stage=0 (Ready to Process).
// Returns null if we can't determine (not configured / API error).
async function countOpenTickets() {
  if (!isConfigured()) return null;
  const boardId = getQuotesBoardId();
  const query = `{
    boards(ids: [${boardId}]) {
      items_page(limit: 500) {
        items {
          column_values(ids: ["${COLS.quotes.stage}"]) { id text value }
        }
      }
    }
  }`;
  try {
    const data = await graphql(query);
    const items = data.boards?.[0]?.items_page?.items || [];
    // Items at stage 0 = "Ready to Process" = still open / un-processed
    return items.filter((item) => {
      const stage = item.column_values?.[0];
      if (!stage) return false;
      // Status columns encode the index in the "value" JSON blob; "text" is the label
      try {
        const parsed = JSON.parse(stage.value || '{}');
        return parsed.index === 0;
      } catch {
        return stage.text === 'Ready to Process';
      }
    }).length;
  } catch (err) {
    logger.warn('countOpenTickets failed:', err.message);
    return null;
  }
}

async function testConnection() {
  try {
    await graphql('{ me { id } }');
    return true;
  } catch (err) {
    logger.warn('Monday test connection failed:', err.message);
    return false;
  }
}

// Test with a specific API key (used during connect flow before saving)
async function testConnectionWithKey(apiKey) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey, 'API-Version': '2023-10' },
      body: JSON.stringify({ query: '{ me { id name } }' }),
    });
    const json = await res.json();
    if (json.errors) return { ok: false, error: json.errors[0]?.message || 'API error' };
    return { ok: true, user: json.data?.me };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Discover boards using a specific key (for connect flow)
async function discoverBoardsWithKey(apiKey) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey, 'API-Version': '2023-10' },
    body: JSON.stringify({ query: '{ boards(limit: 100) { id name description items_count } }' }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || 'API error');
  return json.data?.boards || [];
}

// Fetch columns for a specific board
async function fetchBoardColumns(boardId) {
  const query = `{ boards(ids: [${boardId}]) { columns { id title type } } }`;
  const data = await graphql(query);
  return data.boards?.[0]?.columns || [];
}

module.exports = {
  isConfigured,
  fetchProperties,
  fetchPropertyById,
  findPropertyLive,
  createTicket,
  testConnection,
  testConnectionWithKey,
  discoverBoardsWithKey,
  fetchBoardColumns,
  countOpenTickets,
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  discoverBoards,
  getPropertyBoardId,
  getQuotesBoardId,
  urgencyIndex,
  flagIndex,
  COLS,
  DEFAULT_COLS,
};
