// Frontend routing, auth guard, toasts, and minimal page rendering.

const state = {
  token: localStorage.getItem('arrowhead_token'),
  route: 'dashboard',
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
  const copyBtn = e.target.closest('.btn-copy');
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

async function navigate(route) {
  // Tear down whatever the previous page installed.
  while (pageCleanups.length) {
    try { pageCleanups.pop()(); } catch (_) {}
  }
  state.route = route;
  setActiveTab(route);
  if (route === 'dashboard') {
    renderTemplate('tpl-dashboard');
    await renderDashboardPage();
  } else if (route === 'tickets') {
    renderTemplate('tpl-tickets');
    await renderTicketsPage();
  } else if (route === 'assignment') {
    renderTemplate('tpl-assignment');
    await renderAssignmentPage();
  } else if (route === 'properties') {
    renderTemplate('tpl-properties');
    await renderPropertiesPage();
  } else if (route === 'settings') {
    renderTemplate('tpl-settings');
    await renderSettingsPage();
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

// ---------- Top-bar demo indicator ----------
async function updateDemoIndicator() {
  const el = document.getElementById('demoModeIndicator');
  if (!el) return;
  try {
    const resp = await api('/api/settings');
    const isDemo = !!(resp?.settings?.demo_mode);
    el.hidden = !isDemo;
    // Also reflect it on the <body> so pages can add subtle treatments
    document.body.classList.toggle('is-demo', isDemo);
  } catch (_) {
    el.hidden = true;
  }
  // Fill the account menu with the current username
  try {
    const hint = await api('/api/login-hint').catch(() => null);
    const u = document.getElementById('menuUsername');
    if (u && hint?.username) u.textContent = hint.username;
  } catch (_) {}
}
updateDemoIndicator();
window.updateDemoIndicator = updateDemoIndicator;

// ---------- Home (minimal status + recent list) ----------
async function renderDashboardPage() {
  await Promise.all([updateStatus(), updateActivity()]);
}

async function updateStatus() {
  const dot = document.getElementById('statusDot');
  const title = document.getElementById('heroTitle');
  const sub = document.getElementById('heroSub');
  if (!dot || !title) return;
  try {
    const resp = await api('/api/settings');
    const conn = resp.connections;
    const demo = resp.settings && resp.settings.demo_mode;
    const mondayOk = conn.monday && conn.monday_live;
    if (demo) {
      dot.className = 'status-dot warn';
      title.textContent = 'Demo mode';
      sub.textContent = 'Tickets are simulated — not sent to Monday.com. Turn off in Connections to go live.';
    } else if (mondayOk) {
      dot.className = 'status-dot running';
      title.textContent = 'Running';
      sub.textContent = conn.openrouter
        ? 'Connected to Monday.com · AI parser active · Forward a message to create a ticket.'
        : 'Connected to Monday.com · Using offline parser · Forward a message to create a ticket.';
    } else {
      dot.className = 'status-dot warn';
      title.textContent = 'Not connected';
      sub.textContent = 'Monday.com connection is missing or invalid — open Connections in the menu.';
    }
  } catch (err) {
    dot.className = 'status-dot err';
    title.textContent = 'Offline';
    sub.textContent = err.message;
  }
}
window.updateStatus = updateStatus;

async function updateActivity() {
  const list = document.getElementById('activityList');
  const meta = document.getElementById('activityMeta');
  const footer = document.getElementById('activityFooter');
  const strip = document.getElementById('statsStrip');
  if (!list) return;
  try {
    const [stats, recent] = await Promise.all([api('/api/stats'), api('/api/tickets/recent')]);

    // Stats strip — compact one-line pills. Hidden when no tickets yet.
    if (strip) {
      if (!stats.total) {
        strip.innerHTML = '';
        strip.hidden = true;
      } else {
        strip.hidden = false;
        strip.innerHTML = renderStatsStrip(stats);
      }
    }

    if (meta) {
      const parts = [];
      if (stats.today) parts.push(`${stats.today} today`);
      if (stats.week) parts.push(`${stats.week} this week`);
      meta.textContent = parts.join(' · ');
    }

    if (!recent.length) {
      list.innerHTML = `<li class="activity-empty">No tickets yet. Click <strong>Test Agent</strong> to try it.</li>`;
      if (footer) footer.hidden = true;
      return;
    }
    list.innerHTML = recent.slice(0, 7).map(activityRow).join('');
    if (footer) footer.hidden = recent.length <= 7;
  } catch (err) {
    console.error('activity', err);
  }
}

function renderStatsStrip(stats) {
  const pills = [];

  // Email / SMS breakdown
  pills.push(`<div class="pill">
    <span class="pill-label">Email</span><span class="pill-value">${stats.bySource?.email ?? 0}</span>
    <span class="pill-sep">·</span>
    <span class="pill-label">SMS</span><span class="pill-value">${stats.bySource?.sms ?? 0}</span>
  </div>`);

  // Auto-routed vs flagged
  pills.push(`<div class="pill">
    <span class="pill-label">Auto-routed</span><span class="pill-value">${stats.autoRouted ?? 0}</span>
    ${stats.flagged > 0 ? `<span class="pill-sep">·</span>
      <span class="pill-label warn">Flagged</span><span class="pill-value warn">${stats.flagged}</span>` : ''}
  </div>`);

  // Open on Monday (only if we were able to determine it)
  if (typeof stats.openOnMonday === 'number') {
    pills.push(`<div class="pill">
      <span class="pill-label">Open on Monday</span><span class="pill-value">${stats.openOnMonday}</span>
    </div>`);
  }

  // Spend (if any tokens logged)
  if (stats.tokens && stats.tokens.calls > 0) {
    const cost = (stats.tokens.cost_usd || 0).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    pills.push(`<div class="pill">
      <span class="pill-label">Spend</span><span class="pill-value">$${cost || '0'}</span>
      <span class="pill-sep">·</span>
      <span class="pill-label muted">${stats.tokens.calls} calls</span>
    </div>`);
  }

  return pills.join('');
}
window.refreshStatsAndRecent = () => {
  // Called after a successful pipeline run from demo.js
  updateStatus();
  updateActivity();
};

function activityRow(t) {
  const urgencyCls = t.urgency === 'asap' ? 'asap' : t.urgency === 'urgent' ? 'urgent' : 'normal';
  const href = t.monday_url || '#';
  const external = t.monday_url ? ' target="_blank" rel="noopener"' : '';
  return `<li class="activity-row">
    <span class="ar-time">${fmtTimeShort(t.created_at)}</span>
    <span class="ar-title"><a href="${href}"${external}>${escapeHtml(t.ticket_name)}</a></span>
    <span class="ar-property">${escapeHtml(t.property || '—')}</span>
    <span class="ar-assignee">${escapeHtml(t.assigned_to || '—')}</span>
    <span class="ar-dot ar-dot-${urgencyCls}" title="${(t.urgency || 'normal').toUpperCase()}"></span>
    ${t.flag !== 'ok' ? `<span class="ar-flag">${escapeHtml(t.flag.replace(/_/g, ' '))}</span>` : ''}
  </li>`;
}

function fmtTimeShort(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function urgencyBadge(u) {
  const cls = u === 'asap' ? 'badge-asap' : u === 'urgent' ? 'badge-urgent' : 'badge-normal';
  return `<span class="badge ${cls}">${(u || 'normal').toUpperCase()}</span>`;
}

function flagBadge(f) {
  if (f === 'ok') return `<span class="badge badge-ok">OK</span>`;
  const label = (f || 'unknown').replace(/_/g, ' ').toUpperCase();
  return `<span class="badge badge-needs-review">${label}</span>`;
}

function ticketLink(t) {
  if (t.monday_url) return `<a href="${t.monday_url}" target="_blank" rel="noopener">${escapeHtml(t.ticket_name)} ↗</a>`;
  return escapeHtml(t.ticket_name);
}

// ---------- Tickets page ----------
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
    const tbody = document.getElementById('ticketsTableBody');

    document.getElementById('ticketsMeta').textContent =
      resp.total === 0 ? 'No tickets yet.' : `${resp.total} ticket${resp.total === 1 ? '' : 's'} total`;

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-row">No tickets match filter.</td></tr>';
    } else {
      tbody.innerHTML = items.map((t) => `<tr>
        <td>${fmtDate(t.created_at)}</td>
        <td>${ticketLink(t)}</td>
        <td>${escapeHtml(t.client_name || '—')}</td>
        <td>${escapeHtml(t.property || '—')}</td>
        <td>${escapeHtml(t.work_type || '—')}</td>
        <td>${urgencyBadge(t.urgency)}</td>
        <td>${escapeHtml(t.assigned_to || '—')}</td>
        <td>${flagBadge(t.flag)}</td>
        <td>${(t.source || '').toUpperCase()}</td>
      </tr>`).join('');
    }

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

  document.getElementById('fUrgency').addEventListener('change', reload);
  document.getElementById('fFlag').addEventListener('change', reload);
  document.getElementById('fSource').addEventListener('change', reload);
  // Debounce search — users type fast and we don't want a round-trip per keystroke.
  let t;
  document.getElementById('ticketSearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(reload, 250);
  });
  document.getElementById('ticketsPrev').addEventListener('click', () => { if (st.page > 1) { st.page--; load(); } });
  document.getElementById('ticketsNext').addEventListener('click', () => { st.page++; load(); });
  await load();
}

// ---------- Assignment page ----------
async function renderAssignmentPage() {
  let cfg = await api('/api/assignment-config');

  function renderChips() {
    const tm = document.getElementById('teamMembers');
    tm.innerHTML = cfg.team_members.map((m, i) => `<span class="chip">${escapeHtml(m)}<span class="chip-remove" data-kind="team" data-idx="${i}">✕</span></span>`).join('');
    const kw = document.getElementById('escalationKeywords');
    kw.innerHTML = cfg.escalation_keywords.map((k, i) => `<span class="chip">${escapeHtml(k)}<span class="chip-remove" data-kind="kw" data-idx="${i}">✕</span></span>`).join('');
    document.getElementById('currentIdx').textContent = `${cfg.current_index} → next: ${cfg.team_members[cfg.current_index % (cfg.team_members.length || 1)] || '(none)'}`;
    document.getElementById('escalationTo').value = cfg.escalation_to || '';
  }
  renderChips();

  document.getElementById('pageRoot').addEventListener('click', (e) => {
    const rm = e.target.closest('.chip-remove');
    if (!rm) return;
    const idx = parseInt(rm.dataset.idx, 10);
    if (rm.dataset.kind === 'team') cfg.team_members.splice(idx, 1);
    if (rm.dataset.kind === 'kw') cfg.escalation_keywords.splice(idx, 1);
    renderChips();
  });

  document.getElementById('addMemberBtn').addEventListener('click', () => {
    const i = document.getElementById('newMember');
    const v = i.value.trim();
    if (v) { cfg.team_members.push(v); i.value = ''; renderChips(); }
  });
  document.getElementById('addKeywordBtn').addEventListener('click', () => {
    const i = document.getElementById('newKeyword');
    const v = i.value.trim();
    if (v) { cfg.escalation_keywords.push(v); i.value = ''; renderChips(); }
  });

  document.getElementById('saveAssignmentBtn').addEventListener('click', async () => {
    cfg.escalation_to = document.getElementById('escalationTo').value.trim();
    if (cfg.current_index >= cfg.team_members.length) cfg.current_index = 0;
    const saved = await api('/api/assignment-config', { method: 'PUT', body: JSON.stringify(cfg) });
    cfg = saved;
    renderChips();
    toast.show('Assignment rules saved', 'success');
  });
}

// ---------- Properties page ----------
async function renderPropertiesPage() {
  const PAGE_SIZE = 50;
  const st = { page: 1, all: [], filtered: [], healthTimer: null };

  function renderHealth(status) {
    const dot = document.getElementById('cacheHealthDot');
    const text = document.getElementById('cacheHealthText');
    const meta = document.getElementById('cacheMeta');
    if (!dot || !text || !meta) return;

    // Three states:
    //   live   = webhook received within the last 24h (source: 'webhook' or any source but with fresh webhook)
    //   polled = cache is being kept fresh by the 1h timer but no webhook ever
    //   stale  = webhook was healthy and has now gone silent >24h (actionable warning)
    let state = 'polled';
    let label = 'Polling · webhook not configured';
    if (status.webhook_healthy) {
      state = 'live';
      label = `Live · webhook last fired ${humanAgo(status.last_webhook_ms)}`;
    } else if (status.webhook_ever_received && !status.webhook_healthy) {
      state = 'stale';
      label = `Webhook silent for ${humanAgo(status.last_webhook_ms)} — check Monday settings`;
    } else if (status.source === 'seed') {
      state = 'seed';
      label = 'Seed data · Monday not connected';
    }

    dot.className = `cache-health-dot cache-health-${state}`;
    text.textContent = label;
    meta.textContent = `${status.property_count} properties · updated ${fmtDate(status.updated_at)} · source: ${status.source}`;
  }

  function humanAgo(ms) {
    if (ms === null || ms === undefined) return 'never';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function applyFilter() {
    const q = (document.getElementById('propSearch').value || '').toLowerCase().trim();
    st.filtered = !q
      ? st.all
      : st.all.filter((p) =>
          (`${p.name} ${p.client_name} ${p.address} ${p.property_manager}`).toLowerCase().includes(q)
        );
    st.page = 1;
    renderTable();
  }

  function renderTable() {
    const tbody = document.getElementById('propTableBody');
    const total = st.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (st.page > totalPages) st.page = totalPages;
    const start = (st.page - 1) * PAGE_SIZE;
    const slice = st.filtered.slice(start, start + PAGE_SIZE);

    if (!slice.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No properties match search.</td></tr>';
    } else {
      tbody.innerHTML = slice.map((p) => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.client_name || '—')}</td>
        <td>${escapeHtml(p.address || '—')}</td>
        <td>${escapeHtml(p.property_manager || '—')}</td>
        <td>${escapeHtml(p.manager_phone || '—')}</td>
      </tr>`).join('');
    }

    const pager = document.getElementById('propPager');
    pager.hidden = totalPages <= 1;
    document.getElementById('propPagerInfo').textContent =
      `Showing ${total === 0 ? 0 : start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total}`;
    document.getElementById('propPrev').disabled = st.page <= 1;
    document.getElementById('propNext').disabled = st.page >= totalPages;
  }

  async function loadFull() {
    const data = await api('/api/property-cache');
    st.all = data.properties || [];
    applyFilter();
  }

  async function loadHealth() {
    try {
      const status = await api('/api/property-cache/status');
      renderHealth(status);
    } catch { /* keep previous render */ }
  }

  // Debounced search
  let t;
  document.getElementById('propSearch').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(applyFilter, 150);
  });
  document.getElementById('propPrev').addEventListener('click', () => { if (st.page > 1) { st.page--; renderTable(); } });
  document.getElementById('propNext').addEventListener('click', () => { st.page++; renderTable(); });

  document.getElementById('refreshCacheBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshCacheBtn');
    const originalText = btn.textContent;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Resyncing...';
    try {
      const result = await api('/api/property-cache/refresh', { method: 'POST' });
      await Promise.all([loadFull(), loadHealth()]);
      toast.show(`Resync complete — ${result.properties.length} properties`, 'success');
    } catch (err) {
      toast.show('Resync failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = originalText;
    }
  });

  await Promise.all([loadFull(), loadHealth()]);

  // Keep the cache-health badge live without re-fetching the full property list.
  // Cheap: one GET every 15s that returns ~100 bytes.
  st.healthTimer = setInterval(loadHealth, 15000);
  onPageExit(() => clearInterval(st.healthTimer));
}

// ---------- Settings (Connections) page ----------
async function renderSettingsPage() {
  const resp = await api('/api/settings');
  const conn = resp.connections;
  const settings = resp.settings || {};
  const auth = await api('/api/login-hint').catch(() => null);

  // Demo mode toggle
  const demoToggle = document.getElementById('demoToggle');
  if (demoToggle) {
    demoToggle.checked = !!settings.demo_mode;
    demoToggle.addEventListener('change', async (e) => {
      try {
        await api('/api/settings', { method: 'PUT', body: JSON.stringify({ demo_mode: e.target.checked }) });
        toast.show(e.target.checked ? 'Demo mode ON — tickets simulated' : 'Demo mode OFF — tickets will go to Monday', e.target.checked ? 'info' : 'success');
        updateDemoIndicator();
        // Also refresh the home status hero next time we render
      } catch (err) {
        toast.show('Failed: ' + err.message, 'error');
        e.target.checked = !e.target.checked;
      }
    });
  }

  const connGrid = document.getElementById('connGrid');
  const items = [
    { key: 'monday', label: 'Monday.com', connected: conn.monday, live: conn.monday_live },
    { key: 'openrouter', label: 'OpenRouter (AI)', connected: conn.openrouter },
    { key: 'twilio', label: 'Twilio SMS', connected: conn.twilio },
    { key: 'gmail', label: 'Gmail', connected: conn.gmail },
  ];
  connGrid.innerHTML = items.map((i) => {
    const cls = i.connected ? 'connected' : 'disconnected';
    let status = i.connected ? 'Configured' : 'Not configured';
    if (i.key === 'monday' && i.connected) status = i.live ? 'Connected' : 'Key set but test failed';
    return `<div class="conn-card ${cls}">
      <div class="conn-name">${i.label}</div>
      <div class="conn-status">${status}</div>
    </div>`;
  }).join('');

  if (auth) {
    document.getElementById('currentUser').textContent = auth.username;
    document.getElementById('currentPassword').textContent = auth.password;
  }

  document.getElementById('regenPwdBtn').addEventListener('click', async () => {
    if (!confirm('Regenerate password? You will need to log in again.')) return;
    await api('/api/regenerate-password', { method: 'POST' });
    toast.show('Password regenerated — logging out', 'info');
    setTimeout(() => {
      localStorage.removeItem('arrowhead_token');
      window.location.href = '/';
    }, 900);
  });

}

// Route by hash on load
const initialRoute = (location.hash || '#dashboard').slice(1);
navigate(initialRoute);
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
