// Frontend routing, auth guard, toasts, and minimal page rendering.

const state = {
  token: localStorage.getItem('arrowhead_token'),
  route: 'tickets',
};

if (!state.token) {
  window.location.href = '/';
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
    Authorization: `Bearer ${state.token}`,
  };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('arrowhead_token');
    window.location.href = '/';
    return;
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}
window.api = api;

// ---------- Toast ----------
const toast = {
  show(message, kind = 'success', opts = {}) {
    const root = document.getElementById('toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    const icon = kind === 'success' ? '✓' : kind === 'error' ? '✗' : kind === 'warning' ? '!' : 'i';
    el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg"></span><button class="toast-close" aria-label="Dismiss">×</button>`;
    el.querySelector('.toast-msg').textContent = message;
    el.querySelector('.toast-close').addEventListener('click', () => dismiss());
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    const timeout = setTimeout(dismiss, opts.duration || 4200);
    function dismiss() {
      clearTimeout(timeout);
      el.classList.remove('visible');
      setTimeout(() => el.remove(), 240);
    }
  },
};
window.toast = toast;

// ---------- Copy to clipboard ----------
async function copyFromTarget(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    toast.show('Copied to clipboard', 'success', { duration: 1800 });
  } catch {
    toast.show('Copy failed', 'error');
  }
}

// ---------- Menu dropdown ----------
const menuBtn = document.getElementById('menuToggle');
const menuEl = document.getElementById('menu');
function toggleMenu(force) {
  const willOpen = force !== undefined ? force : menuEl.hidden;
  menuEl.hidden = !willOpen;
  menuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
document.addEventListener('click', (e) => {
  if (!menuEl.hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuEl.hidden) toggleMenu(false);
});

// ---------- Global click: routes + copy buttons ----------
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.btn-copy, .btn-copy-sm, .tp-copy');
  if (copyBtn) {
    copyFromTarget(copyBtn.dataset.copyTarget);
    return;
  }
  const route = e.target.closest('[data-route]');
  if (route && route.dataset.route) {
    e.preventDefault();
    window.location.hash = route.dataset.route;
    toggleMenu(false);
  }
});

// ---------- Routing ----------
function renderTemplate(id) {
  const tpl = document.getElementById(id);
  const root = document.getElementById('pageRoot');
  root.innerHTML = '';
  root.appendChild(tpl.content.cloneNode(true));
}

function setActiveTab(route) {
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === route);
  });
}

// Pages can register cleanup callbacks (timers, observers) that run when the
// user navigates away. Keeps `setInterval` polls from leaking across routes.
const pageCleanups = [];
function onPageExit(fn) { pageCleanups.push(fn); }

// Scroll position memory per route
const scrollPositions = {};

async function navigate(route) {
  // Save scroll position of the page we're leaving
  if (state.route) scrollPositions[state.route] = window.scrollY;

  // Tear down whatever the previous page installed.
  while (pageCleanups.length) {
    try { pageCleanups.pop()(); } catch (_) {}
  }
  // Redirect removed routes to tickets
  if (route === 'dashboard' || route === 'properties') route = 'tickets';
  state.route = route;
  setActiveTab(route);
  if (route === 'tickets') {
    renderTemplate('tpl-tickets');
    await renderTicketsPage();
  } else if (route === 'assignment') {
    renderTemplate('tpl-assignment');
    await renderAssignmentPage();
  } else if (route === 'settings') {
    renderTemplate('tpl-settings');
    await renderSettingsPage();
  }
  // Restore scroll position if returning to a previously visited route
  if (scrollPositions[route]) {
    window.scrollTo(0, scrollPositions[route]);
  }
  // Refresh the top-bar demo indicator whenever the route changes too,
  // so if someone toggles demo-mode and navigates, it stays in sync.
  updateDemoIndicator();
}

// ---------- Logout ----------
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  localStorage.removeItem('arrowhead_token');
  window.location.href = '/';
});

// Initialize demo modal (runs once — handles re-open idempotency internally)
window.demo.init();

// ---------- Demo indicator + status ----------
async function updateDemoIndicator() {
  // Fill the account menu with the current username
  try {
    const hint = await api('/api/login-hint').catch(() => null);
    const u = document.getElementById('menuUsername');
    if (u && hint?.username) u.textContent = hint.username;
  } catch (_) {}
}
updateDemoIndicator();
window.updateDemoIndicator = updateDemoIndicator;

// Loads status, demo state, and agent contact info into the instruction panel
async function updateStatus() {
  const dot = document.getElementById('statusDot');
  const title = document.getElementById('heroTitle');
  const sub = document.getElementById('heroSub');
  const demoBadge = document.getElementById('demoIndicatorInline');
  if (!dot || !title) return;
  try {
    const resp = await api('/api/settings');
    const conn = resp.connections;
    const demo = resp.settings && resp.settings.demo_mode;
    const mondayOk = conn.monday && conn.monday_live;
    const contact = resp.agent_contact || {};

    // Status indicator
    const hint = document.getElementById('demoHint');
    if (demo) {
      dot.className = 'status-dot warn';
      title.textContent = 'Demo mode';
      sub.textContent = 'Tickets simulated — not sent to Monday.com';
      if (hint) hint.hidden = false;
    } else if (mondayOk) {
      dot.className = 'status-dot running';
      title.textContent = 'Running';
      sub.textContent = 'Forward a text or email to create a ticket';
      if (hint) hint.hidden = true;
    } else {
      dot.className = 'status-dot warn';
      title.textContent = 'Not connected';
      sub.textContent = 'Monday.com missing — check Integration tab';
      if (hint) hint.hidden = true;
    }

    // Demo badge
    if (demoBadge) demoBadge.hidden = !demo;
    document.body.classList.toggle('is-demo', !!demo);

    // Agent contact info
    const emailEl = document.getElementById('contactEmail');
    const phoneEl = document.getElementById('contactPhone');
    if (emailEl && contact.email) {
      document.getElementById('agentEmail').textContent = contact.email;
      emailEl.hidden = false;
    }
    if (phoneEl && contact.phone) {
      document.getElementById('agentPhone').textContent = contact.phone;
      phoneEl.hidden = false;
    }
  } catch (err) {
    dot.className = 'status-dot err';
    title.textContent = 'Offline';
    sub.textContent = err.message;
  }
}
window.updateStatus = updateStatus;

// ---------- Stats strip (used by tickets page) ----------
function renderStatsStrip(stats) {
  const pills = [];

  pills.push(`<div class="pill">
    <span class="pill-label">Email</span><span class="pill-value">${stats.bySource?.email ?? 0}</span>
    <span class="pill-sep">·</span>
    <span class="pill-label">SMS</span><span class="pill-value">${stats.bySource?.sms ?? 0}</span>
  </div>`);

  pills.push(`<div class="pill">
    <span class="pill-label">Auto-routed</span><span class="pill-value">${stats.autoRouted ?? 0}</span>
    ${stats.flagged > 0 ? `<span class="pill-sep">·</span>
      <span class="pill-label warn">Flagged</span><span class="pill-value warn">${stats.flagged}</span>` : ''}
  </div>`);

  if (typeof stats.openOnMonday === 'number') {
    pills.push(`<div class="pill">
      <span class="pill-label">Open on Monday</span><span class="pill-value">${stats.openOnMonday}</span>
    </div>`);
  }

  return pills.join('');
}

async function updateStatsStrip() {
  const strip = document.getElementById('statsStrip');
  if (!strip) return;
  try {
    const stats = await api('/api/stats');
    if (!stats.total) {
      strip.innerHTML = '';
      strip.hidden = true;
    } else {
      strip.hidden = false;
      strip.innerHTML = renderStatsStrip(stats);
    }
  } catch (_) {}
}

window.refreshStatsAndRecent = () => {
  // Called after a successful pipeline run from demo.js
  updateStatus();
  updateStatsStrip();
  // Reload the ticket table if we're on the tickets page
  if (state.route === 'tickets' && window._reloadTickets) window._reloadTickets();
};

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Render editable field mapping: left = label input, right = column dropdown
// boardColumns = array from /api/monday-columns/:id (may be empty if not loaded yet)
function renderFieldMap(containerId, boardConfig, boardColumns, boardType) {
  const el = document.getElementById(containerId);
  if (!el || !boardConfig) { if (el) el.innerHTML = ''; return; }
  const cols = boardColumns || [];
  el.innerHTML =
    `<div class="field-map-board">Board ID: ${escapeHtml(boardConfig.board_id)}</div>` +
    `<div class="field-map-header">Display Label</div><div class="field-map-header">Monday.com Column</div>` +
    boardConfig.columns.map((c) => {
      // Label input (left side — editable)
      const labelInput = `<input class="field-map-input" data-field="${escapeHtml(c.field)}" data-type="label" value="${escapeHtml(c.label || c.field)}" />`;
      // Column dropdown (right side — select from board columns)
      let colSelect;
      if (cols.length) {
        const options = `<option value="">— not mapped —</option>` +
          cols.map((bc) => `<option value="${escapeHtml(bc.id)}" ${bc.id === c.column_id ? 'selected' : ''}>${escapeHtml(bc.title)} (${escapeHtml(bc.type)})</option>`).join('');
        colSelect = `<select class="field-map-select" data-field="${escapeHtml(c.field)}" data-type="column">${options}</select>`;
      } else {
        colSelect = `<span class="field-map-col">${escapeHtml(c.column_id)}</span>`;
      }
      return `<div class="field-map-cell">${labelInput}</div><div class="field-map-cell">${colSelect}</div>`;
    }).join('') +
    `<div class="field-map-actions"><button class="btn btn-primary btn-sm field-map-save" data-board-type="${escapeHtml(boardType || '')}">Save mapping</button></div>`;
}

function urgencyBadge(u) {
  const cls = u === 'asap' ? 'badge-asap' : u === 'urgent' ? 'badge-urgent' : 'badge-normal';
  return `<span class="badge ${cls}">${(u || 'normal').toUpperCase()}</span>`;
}

function statusBadge(f) {
  if (f === 'ok') return `<span class="badge badge-ok">Processed</span>`;
  const label = (f || 'unknown').replace(/_/g, ' ');
  const cls = f === 'location_not_found' ? 'badge-needs-review' : f === 'needs_assignment' ? 'badge-needs-review' : 'badge-needs-review';
  return `<span class="badge ${cls}">${label.charAt(0).toUpperCase() + label.slice(1)}</span>`;
}

function sourceIcon(src) {
  if (src === 'email') return `<svg class="feed-source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>`;
  if (src === 'sms') return `<svg class="feed-source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  return '';
}

// Field labels — loaded from settings, used in feed cards and elsewhere
let fieldLabels = { properties: {}, quotes: {} };
async function loadFieldLabels() {
  try {
    fieldLabels = await api('/api/field-labels');
  } catch { /* use defaults */ }
}

function lbl(board, field, fallback) {
  return (fieldLabels[board] && fieldLabels[board][field]) || fallback;
}

function feedCard(t) {
  const urgencyCls = t.urgency === 'asap' ? 'feed-card-asap' : t.urgency === 'urgent' ? 'feed-card-urgent' : '';
  const href = t.monday_url || '';
  const linkOpen = href ? `<a href="${href}" target="_blank" rel="noopener" class="feed-card-link">` : '';
  const linkClose = href ? '</a>' : '';
  const propLabel = lbl('properties', 'client_name', 'Client');
  return `<div class="feed-card ${urgencyCls}">
    <div class="feed-card-left">
      <div class="feed-card-source" title="${(t.source || '').toUpperCase()}" role="img" aria-label="Source: ${(t.source || '').toUpperCase()}">${sourceIcon(t.source)}</div>
    </div>
    <div class="feed-card-body">
      <div class="feed-card-row1">
        <span class="feed-card-title">${linkOpen}${escapeHtml(t.ticket_name)}${href ? ' ↗' : ''}${linkClose}</span>
        <span class="feed-card-time">${fmtDate(t.created_at)}</span>
      </div>
      <div class="feed-card-row2">
        ${t.property ? `<span class="feed-card-detail">${escapeHtml(t.property)}</span>` : ''}
        ${t.client_name ? `<span class="feed-card-detail feed-card-client" title="${escapeHtml(propLabel)}">${escapeHtml(t.client_name)}</span>` : ''}
        ${t.work_type ? `<span class="feed-card-detail feed-card-work">${escapeHtml(t.work_type)}</span>` : ''}
      </div>
      <div class="feed-card-row3">
        ${statusBadge(t.flag)}
        ${urgencyBadge(t.urgency)}
        ${t.assigned_to ? `<span class="feed-card-assignee">${escapeHtml(t.assigned_to)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

// ---------- Tickets page (consolidated: status + stats + chronological feed) ----------
async function renderTicketsPage() {
  const PAGE_SIZE = 50;
  const st = { page: 1 };

  async function load() {
    const urgency = document.getElementById('fUrgency').value;
    const flag = document.getElementById('fFlag').value;
    const source = document.getElementById('fSource').value;
    const q = document.getElementById('ticketSearch').value.trim();
    const qs = new URLSearchParams();
    if (urgency) qs.set('urgency', urgency);
    if (flag) qs.set('flag', flag);
    if (source) qs.set('source', source);
    if (q) qs.set('q', q);
    qs.set('page', String(st.page));
    qs.set('pageSize', String(PAGE_SIZE));

    const resp = await api(`/api/tickets?${qs.toString()}`);
    const items = resp.items || [];
    const feed = document.getElementById('ticketsFeed');

    document.getElementById('ticketsMeta').textContent =
      resp.total === 0 ? 'No requests yet' : `${resp.total} request${resp.total === 1 ? '' : 's'}`;

    // Preserve scroll position during auto-refresh updates
    const scrollY = window.scrollY;
    if (!items.length) {
      feed.innerHTML = `<div class="feed-empty">No requests match your filters. Click <strong>Test Agent</strong> to simulate one.</div>`;
    } else {
      feed.innerHTML = items.map(feedCard).join('');
    }
    window.scrollTo(0, scrollY);

    // Pager
    const pager = document.getElementById('ticketsPager');
    const info = document.getElementById('ticketsPagerInfo');
    const prev = document.getElementById('ticketsPrev');
    const next = document.getElementById('ticketsNext');
    pager.hidden = resp.totalPages <= 1;
    info.textContent = `Page ${resp.page} of ${resp.totalPages}`;
    prev.disabled = resp.page <= 1;
    next.disabled = resp.page >= resp.totalPages;
  }

  function reload() { st.page = 1; load(); }

  // Expose reload for refreshStatsAndRecent (called after pipeline runs)
  window._reloadTickets = reload;
  onPageExit(() => { window._reloadTickets = null; });

  document.getElementById('fUrgency').addEventListener('change', reload);
  document.getElementById('fFlag').addEventListener('change', reload);
  document.getElementById('fSource').addEventListener('change', reload);
  let t;
  document.getElementById('ticketSearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(reload, 250);
  });
  document.getElementById('ticketsPrev').addEventListener('click', () => { if (st.page > 1) { st.page--; load(); } });
  document.getElementById('ticketsNext').addEventListener('click', () => { st.page++; load(); });

  // Load status hero, stats strip, labels, and feed in parallel
  await Promise.all([updateStatus(), updateStatsStrip(), loadFieldLabels(), load()]);

  // Auto-refresh: poll for new tickets every 15 seconds
  const refreshTimer = setInterval(() => {
    load();
    updateStatsStrip();
  }, 15000);
  onPageExit(() => clearInterval(refreshTimer));
}

// ---------- Assignment page ----------
async function renderAssignmentPage() {
  let cfg = await api('/api/assignment-config');

  function renderChips() {
    const kw = document.getElementById('escalationKeywords');
    kw.innerHTML = (cfg.escalation_keywords || []).map((k, i) => `<span class="chip">${escapeHtml(k)}<span class="chip-remove" data-kind="kw" data-idx="${i}">✕</span></span>`).join('');
  }

  // Populate fields
  document.getElementById('defaultAssignee').value = cfg.default_assignee || cfg.escalation_to || '';
  document.getElementById('escalationTo').value = cfg.escalation_to || '';
  renderChips();

  document.getElementById('pageRoot').addEventListener('click', (e) => {
    const rm = e.target.closest('.chip-remove');
    if (!rm) return;
    const idx = parseInt(rm.dataset.idx, 10);
    if (rm.dataset.kind === 'kw') cfg.escalation_keywords.splice(idx, 1);
    renderChips();
  });

  document.getElementById('addKeywordBtn').addEventListener('click', () => {
    const i = document.getElementById('newKeyword');
    const v = i.value.trim();
    if (v) { cfg.escalation_keywords.push(v); i.value = ''; renderChips(); }
  });

  document.getElementById('saveAssignmentBtn').addEventListener('click', async () => {
    cfg.default_assignee = document.getElementById('defaultAssignee').value.trim();
    cfg.escalation_to = document.getElementById('escalationTo').value.trim();
    const saved = await api('/api/assignment-config', { method: 'PUT', body: JSON.stringify(cfg) });
    cfg = saved;
    renderChips();
    toast.show('Assignment rules saved', 'success');
  });
}

// ---------- Settings (Integration) page ----------
async function renderSettingsPage() {
  // --- Monday.com connect flow ---
  let mondayBoards = [];

  let inputBoardCols = [];
  let outputBoardCols = [];

  async function loadBoardColumns(boardId) {
    if (!boardId) return [];
    try {
      const data = await api(`/api/monday-columns/${boardId}`);
      return data.columns || [];
    } catch { return []; }
  }

  async function loadMondayState() {
    try {
      const cfg = await api('/api/monday-config');
      if (cfg.has_key) {
        document.getElementById('mondayConnect').hidden = true;
        document.getElementById('mondayConnected').hidden = false;
        try {
          const data = await api('/api/monday-boards');
          mondayBoards = data.boards || [];
        } catch { mondayBoards = []; }
        populateBoardSelect('mondayInputBoard', mondayBoards, cfg.input_board_id);
        populateBoardSelect('mondayOutputBoard', mondayBoards, cfg.output_board_id);
        // Load board columns and render editable field maps
        if (cfg.input_board_id) {
          inputBoardCols = await loadBoardColumns(cfg.input_board_id);
          renderFieldMap('fieldMapProperties', cfg.properties, inputBoardCols, 'properties');
        }
        if (cfg.output_board_id) {
          outputBoardCols = await loadBoardColumns(cfg.output_board_id);
          renderFieldMap('fieldMapQuotes', cfg.quotes, outputBoardCols, 'quotes');
        }
      } else {
        document.getElementById('mondayConnect').hidden = false;
        document.getElementById('mondayConnected').hidden = true;
      }
    } catch (_) {}
  }

  function populateBoardSelect(selectId, boards, selectedId) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = '<option value="">Select a board...</option>' +
      boards.map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === selectedId ? 'selected' : ''}>${escapeHtml(b.name)} (${b.items_count || 0} items)</option>`).join('');
  }

  // Connect button
  document.getElementById('mondayConnectBtn').addEventListener('click', async () => {
    const keyInput = document.getElementById('mondayApiKey');
    const statusEl = document.getElementById('mondayConnectStatus');
    const btn = document.getElementById('mondayConnectBtn');
    const keyVal = keyInput.value.trim();
    if (!keyVal) { statusEl.textContent = 'Enter an API key.'; return; }
    btn.disabled = true; statusEl.textContent = 'Connecting...';
    try {
      const result = await api('/api/monday-connect', { method: 'POST', body: JSON.stringify({ api_key: keyVal }) });
      toast.show('Connected to Monday.com' + (result.user?.name ? ` as ${result.user.name}` : ''), 'success');
      await loadMondayState();
    } catch (err) {
      statusEl.textContent = 'Failed: ' + err.message;
    } finally { btn.disabled = false; }
  });

  // Disconnect button
  document.getElementById('mondayDisconnectBtn').addEventListener('click', async () => {
    if (!confirm('Disconnect Monday.com? Board selections will be cleared.')) return;
    await api('/api/monday-disconnect', { method: 'POST' });
    toast.show('Monday.com disconnected', 'info');
    document.getElementById('mondayConnect').hidden = false;
    document.getElementById('mondayConnected').hidden = true;
    document.getElementById('mondayApiKey').value = '';
    document.getElementById('fieldMapProperties').innerHTML = '';
    document.getElementById('fieldMapQuotes').innerHTML = '';
  });

  // Board selection change — save + load columns + render editable map
  async function onBoardChange(selectId, boardType) {
    const boardId = document.getElementById(selectId).value;
    const body = {};
    if (boardType === 'input') body.input_board_id = boardId;
    else body.output_board_id = boardId;
    await api('/api/monday-boards', { method: 'PUT', body: JSON.stringify(body) });
    const cfg = await api('/api/monday-config');
    if (boardType === 'input') {
      inputBoardCols = boardId ? await loadBoardColumns(boardId) : [];
      renderFieldMap('fieldMapProperties', cfg.properties, inputBoardCols, 'properties');
    } else {
      outputBoardCols = boardId ? await loadBoardColumns(boardId) : [];
      renderFieldMap('fieldMapQuotes', cfg.quotes, outputBoardCols, 'quotes');
    }
    toast.show(`${boardType === 'input' ? 'Input' : 'Output'} board updated`, 'success', { duration: 2000 });
  }
  document.getElementById('mondayInputBoard').addEventListener('change', () => onBoardChange('mondayInputBoard', 'input'));
  document.getElementById('mondayOutputBoard').addEventListener('change', () => onBoardChange('mondayOutputBoard', 'output'));

  // Save field mapping (delegated click — buttons are inside dynamic content)
  document.getElementById('pageRoot').addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('.field-map-save');
    if (!saveBtn) return;
    const boardType = saveBtn.dataset.boardType;
    const container = saveBtn.closest('.field-map') || saveBtn.parentElement.parentElement;
    const labels = {};
    const columnIds = {};
    container.querySelectorAll('.field-map-input').forEach((inp) => {
      labels[inp.dataset.field] = inp.value.trim();
    });
    container.querySelectorAll('.field-map-select').forEach((sel) => {
      if (sel.value) columnIds[sel.dataset.field] = sel.value;
    });
    saveBtn.disabled = true;
    try {
      await api('/api/monday-field-config', {
        method: 'PUT',
        body: JSON.stringify({ board_type: boardType, labels, column_ids: Object.keys(columnIds).length ? columnIds : undefined }),
      });
      toast.show('Field mapping saved', 'success');
    } catch (err) {
      toast.show('Save failed: ' + err.message, 'error');
    } finally { saveBtn.disabled = false; }
  });

  await loadMondayState();

  // ---------- Parser Prompt Editor ----------
  const promptEl = document.getElementById('parserPrompt');
  const promptVarsEl = document.getElementById('promptVariables');
  const promptStatus = document.getElementById('promptStatus');
  let defaultPrompt = '';

  try {
    const promptData = await api('/api/parser-prompt');
    promptEl.value = promptData.prompt;
    defaultPrompt = promptData.default_prompt;

    // Render variable insertion buttons
    promptVarsEl.innerHTML = (promptData.variables || []).map((v) =>
      `<button type="button" class="prompt-var-btn" data-var="${escapeHtml(v.key)}" title="${escapeHtml(v.description)}">${escapeHtml(v.key)}</button>`
    ).join('');
  } catch (err) {
    promptEl.value = '(Failed to load prompt)';
    promptEl.disabled = true;
  }

  // Insert variable at cursor position
  promptVarsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.prompt-var-btn');
    if (!btn) return;
    const varText = btn.dataset.var;
    const start = promptEl.selectionStart;
    const end = promptEl.selectionEnd;
    const before = promptEl.value.slice(0, start);
    const after = promptEl.value.slice(end);
    promptEl.value = before + varText + after;
    promptEl.focus();
    promptEl.selectionStart = promptEl.selectionEnd = start + varText.length;
  });

  // Save prompt
  document.getElementById('savePromptBtn').addEventListener('click', async () => {
    const btn = document.getElementById('savePromptBtn');
    btn.disabled = true;
    try {
      await api('/api/parser-prompt', { method: 'PUT', body: JSON.stringify({ prompt: promptEl.value }) });
      toast.show('Parser prompt saved', 'success');
      promptStatus.textContent = 'Saved';
      setTimeout(() => { promptStatus.textContent = ''; }, 3000);
    } catch (err) {
      toast.show('Save failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Reset to default
  document.getElementById('resetPromptBtn').addEventListener('click', async () => {
    if (!confirm('Reset parser prompt to the default? Your custom prompt will be lost.')) return;
    try {
      const result = await api('/api/parser-prompt/reset', { method: 'POST' });
      promptEl.value = result.prompt;
      toast.show('Prompt reset to default', 'info');
    } catch (err) {
      toast.show('Reset failed: ' + err.message, 'error');
    }
  });

  // Ctrl/Cmd+S shortcut to save prompt when textarea is focused
  promptEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('savePromptBtn').click();
    }
  });
}

// Route by hash on load
const initialRoute = (location.hash || '#tickets').slice(1);
navigate(initialRoute);
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
