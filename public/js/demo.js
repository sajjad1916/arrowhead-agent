// Test Agent — compose in modal, processing renders inline in the ticket feed.

const ICONS = {
  received: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></svg>',
  parse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2a3 3 0 0 0-3 3v2.4a3 3 0 0 1-.88 2.12L6.7 10.94a3 3 0 0 0 0 4.24l1.42 1.42A3 3 0 0 1 9 18.6V21a3 3 0 0 0 6 0v-2.4a3 3 0 0 1 .88-2.12l1.42-1.42a3 3 0 0 0 0-4.24l-1.42-1.42A3 3 0 0 1 15 7.4V5a3 3 0 0 0-3-3z"/></svg>',
  match: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  assign: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  create: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h3m-3 4h5"/></svg>',
  complete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

const demo = {
  templates: null,
  currentSource: 'email',
  activeTemplateKey: null,
  running: false,

  async init() {
    if (this._wired) return;
    this._wired = true;
    this.modal = document.getElementById('testModal');

    document.addEventListener('click', (e) => {
      if (e.target.closest('#openTestBtnInline')) this.open();
    });
    document.getElementById('modalCloseBtn').addEventListener('click', () => this.close());
    document.getElementById('modalCancelBtn').addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.modal.hidden) this.close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.modal.hidden) {
        e.preventDefault();
        if (!this.running) this.run();
      }
    });

    this.modal.querySelectorAll('.source-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._setSource(btn.dataset.source));
    });
    document.getElementById('modalRunBtn').addEventListener('click', () => this.run());

    try {
      this.templates = await window.api('/api/templates');
    } catch { this.templates = { email: [], sms: [] }; }
    this._renderTemplates();
  },

  open() {
    this.modal.hidden = false;
    requestAnimationFrame(() => this.modal.classList.add('visible'));
    document.body.classList.add('modal-open');
    setTimeout(() => document.getElementById('modalMessage').focus(), 200);
  },

  close() {
    this.modal.classList.remove('visible');
    document.body.classList.remove('modal-open');
    setTimeout(() => { this.modal.hidden = true; }, 180);
  },

  _setSource(source) {
    this.currentSource = source;
    this.modal.querySelectorAll('.source-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === source);
    });
    document.getElementById('modalMessage').value = '';
    this.activeTemplateKey = null;
    this._renderTemplates();
  },

  _renderTemplates() {
    const root = document.getElementById('modalTemplates');
    if (!root || !this.templates) return;
    const list = this.templates[this.currentSource] || [];
    const srcIcon = this.currentSource === 'email'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    root.innerHTML = list.map((t) => {
      const label = this.currentSource === 'email' ? t.subject : t.body.slice(0, 50) + (t.body.length > 50 ? '…' : '');
      const active = this.activeTemplateKey === t.key ? ' active' : '';
      return `<button type="button" class="tpl-chip${active}" data-key="${t.key}"><span class="tpl-chip-icon">${srcIcon}</span><span class="tpl-chip-label">${escapeHtml(label)}</span></button>`;
    }).join('');
    root.querySelectorAll('.tpl-chip').forEach((chip) => {
      chip.addEventListener('click', () => this._pickTemplate(chip.dataset.key));
    });
  },

  _pickTemplate(key) {
    const list = this.templates[this.currentSource] || [];
    const tpl = list.find((t) => t.key === key);
    if (!tpl) return;
    this.activeTemplateKey = key;
    const textarea = document.getElementById('modalMessage');
    textarea.value = this.currentSource === 'email' ? `Subject: ${tpl.subject}\n\n${tpl.body}` : tpl.body;
    this._renderTemplates();
  },

  async run() {
    if (this.running) return;
    const message = document.getElementById('modalMessage').value.trim();
    if (!message) { window.toast.show('Pick a template or type a message first', 'warning'); return; }

    this.running = true;
    const runBtn = document.getElementById('modalRunBtn');
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner"></span> Running...';

    // Close modal and inject horizontal processing row into the feed
    this.close();
    const feed = document.getElementById('ticketsFeed');
    const procCard = document.createElement('div');
    procCard.className = 'proc-card';

    // Build step placeholders — all pending initially
    const STEP_KEYS = ['received', 'parse', 'match', 'assign', 'create', 'complete'];
    const STEP_LABELS = { received: 'Received', parse: 'Parsing', match: 'Matching', assign: 'Assigning', create: 'Creating', complete: 'Done' };
    procCard.innerHTML = `<div class="proc-row">${STEP_KEYS.map((k) =>
      `<div class="proc-step" id="ps-${k}" data-status="waiting">
        <div class="proc-step-dot"></div>
        <span class="proc-step-label">${STEP_LABELS[k]}</span>
      </div>`
    ).join('<div class="proc-step-line"></div>')}</div>`;

    if (feed) {
      feed.insertBefore(procCard, feed.firstChild);
      requestAnimationFrame(() => procCard.classList.add('visible'));
    }

    let sendMessage = message;
    if (this.currentSource === 'email' && /^subject:/i.test(sendMessage)) {
      const parts = sendMessage.split(/\n\n/);
      if (parts.length >= 2) sendMessage = parts.slice(1).join('\n\n');
    }

    // Mark a step as active (running)
    function setStepActive(key) {
      const el = procCard.querySelector(`#ps-${key}`);
      if (el) el.dataset.status = 'active';
    }
    // Mark a step as done
    function setStepDone(key, status) {
      const el = procCard.querySelector(`#ps-${key}`);
      if (el) el.dataset.status = status || 'success';
    }

    // Start first step as active
    setStepActive('received');

    let result;
    try {
      result = await window.api('/api/demo/process', {
        method: 'POST',
        body: JSON.stringify({ message: sendMessage, source: this.currentSource }),
      });
    } catch (err) {
      STEP_KEYS.forEach((k) => {
        const el = procCard.querySelector(`#ps-${k}`);
        if (el && el.dataset.status !== 'success') el.dataset.status = 'error';
      });
      runBtn.disabled = false; runBtn.innerHTML = 'Run Test'; this.running = false;
      window.toast.show('Pipeline failed: ' + err.message, 'error');
      return;
    }

    // Animate steps to completion
    const steps = result.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      setStepActive(step.key);
      await sleep(i === 0 ? 80 : 200);
      setStepDone(step.key, step.status);
      // Activate next step
      if (i + 1 < steps.length) setStepActive(steps[i + 1].key);
    }

    // Show ticket name below the steps
    const ticket = result.ticket || {};
    const mondayLink = ticket.monday_url ? ` <a href="${ticket.monday_url}" target="_blank" rel="noopener" class="proc-result-link">Monday.com ↗</a>` : '';
    const resultBar = document.createElement('div');
    resultBar.className = 'proc-result';
    resultBar.innerHTML = `<span class="proc-result-name">${escapeHtml(ticket.ticket_name || 'Ticket created')}</span>${mondayLink}`;
    procCard.appendChild(resultBar);

    // Reset modal + refresh
    document.getElementById('modalMessage').value = '';
    this.activeTemplateKey = null;
    this._renderTemplates();
    runBtn.disabled = false; runBtn.innerHTML = 'Run Test'; this.running = false;

    if (window.refreshStatsAndRecent) {
      try { window.refreshStatsAndRecent(); } catch {}
    }
    window.toast.show(
      ticket.simulated ? 'Ticket simulated — Monday not connected' : 'Ticket created on Monday.com',
      ticket.simulated ? 'info' : 'success'
    );
  },
};

// ---------- helpers ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderKV(label, value) {
  if (value === undefined || value === null || value === '') {
    return `<div class="kv"><span class="k">${label}</span><span class="v null-val">—</span></div>`;
  }
  return `<div class="kv"><span class="k">${label}</span><span class="v">${escapeHtml(value)}</span></div>`;
}

function renderStep(step, pending) {
  const div = document.createElement('div');
  const status = pending ? 'pending' : (step.status || 'success');
  div.className = `pipeline-step ${status}`;
  const statusLabel = pending ? 'Running' : status === 'success' ? 'Success' : status === 'warning' ? 'Warning' : status === 'error' ? 'Error' : status;
  const detail = pending ? '<div class="step-detail"><span class="spinner"></span> Working…</div>' : renderStepDetail(step);
  const icon = ICONS[step.key] || ICONS.complete;
  div.innerHTML = `<div class="step-icon">${icon}</div>
    <div class="step-body">
      <div class="step-title">${escapeHtml(step.title)}<span class="step-status ${status}">${statusLabel}</span></div>
      ${detail}
    </div>`;
  return div;
}

function renderStepDetail(step) {
  const d = step.data || {};
  switch (step.key) {
    case 'received':
      return `<div class="step-detail">
        ${renderKV('Source', (d.source || '').toUpperCase())}
        ${renderKV('Length', `${d.length} chars`)}
        <div class="raw-box">${escapeHtml(d.cleaned || d.raw || '')}</div>
      </div>`;
    case 'parse':
      return `<div class="step-detail">
        ${renderKV('Parser', d.parser)}
        ${renderKV('Client', d.parsed?.client_name)}
        ${renderKV('Property Reference', d.parsed?.property_reference)}
        ${renderKV('Work Type', d.parsed?.work_type)}
        ${renderKV('Urgency', d.parsed?.urgency)}
        ${renderKV('Additional Context', d.parsed?.additional_context)}
        ${renderKV('Forwarder Note', d.parsed?.forwarder_context)}
      </div>`;
    case 'match':
      if (d.match) {
        return `<div class="step-detail">
          ${renderKV('Reference', d.reference)}
          ${renderKV('Matched', d.match.name)}
          ${renderKV('Score', d.score)}
          ${renderKV('Address', d.match.address)}
          ${renderKV('Client', d.match.client_name)}
          ${renderKV('Manager', d.match.property_manager)}
        </div>`;
      }
      return `<div class="step-detail">${renderKV('Reference', d.reference)}<div class="kv"><span class="k">Result</span><span class="v null-val">No match — flagged for review</span></div></div>`;
    case 'assign':
      return `<div class="step-detail">
        ${renderKV('Assigned To', d.assignedTo)}
        ${d.escalated ? renderKV('Escalated', 'Yes — urgency') : ''}
        ${d.returning ? renderKV('Returning Customer', 'Yes — same CSR') : ''}
      </div>`;
    case 'create': {
      const p = d.preview || {};
      return `<div class="step-detail">
        ${d.simulated ? renderKV('Mode', 'Simulated') : ''}
        ${d.ticketId ? renderKV('Ticket ID', d.ticketId) : ''}
        ${renderKV('Name', p.name)}
        ${renderKV('Client', p.clientName)}
        ${renderKV('Work Type', p.workType)}
        ${renderKV('Flag', (p.flag || '').replace(/_/g, ' '))}
      </div>`;
    }
    case 'complete':
      return `<div class="step-detail">
        ${d.confirmationMessage ? renderKV('Result', d.confirmationMessage) : ''}
      </div>`;
  }
  return '';
}

function urgencyBadgeFor(u) {
  const cls = u === 'asap' ? 'badge-asap' : u === 'urgent' ? 'badge-urgent' : 'badge-normal';
  return `<span class="badge ${cls}">${(u || 'normal').toUpperCase()}</span>`;
}

window.demo = demo;
