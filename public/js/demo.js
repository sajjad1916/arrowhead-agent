// Test Agent modal — minimal one-click testing flow.

// Inline SVG icon set (mono line icons, currentColor) — replaces emoji hints.
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
    if (this._wired) {
      this._resetModal();
      return;
    }
    this._wired = true;
    this.modal = document.getElementById('testModal');

    // Open modal
    document.getElementById('openTestBtn').addEventListener('click', () => this.open());

    // Close
    document.getElementById('modalCloseBtn').addEventListener('click', () => this.close());
    document.getElementById('modalCancelBtn').addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.modal.hidden) this.close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !this.modal.hidden) {
        e.preventDefault();
        if (!this.running) this.run();
      }
    });

    // Source toggle
    this.modal.querySelectorAll('.source-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._setSource(btn.dataset.source));
    });

    // Run button
    document.getElementById('modalRunBtn').addEventListener('click', () => this.run());

    // Run another
    document.getElementById('successAnotherBtn').addEventListener('click', () => this._resetModal());

    // Fetch templates once
    try {
      this.templates = await window.api('/api/templates');
    } catch (err) {
      console.error('templates', err);
      this.templates = { email: [], sms: [] };
    }
    this._renderTemplates();
  },

  open() {
    this.modal.hidden = false;
    requestAnimationFrame(() => this.modal.classList.add('visible'));
    document.body.classList.add('modal-open');
    // Focus the textarea after animation
    setTimeout(() => document.getElementById('modalMessage').focus(), 200);
  },

  close() {
    this.modal.classList.remove('visible');
    document.body.classList.remove('modal-open');
    setTimeout(() => {
      this.modal.hidden = true;
      this._resetModal();
    }, 180);
    // Ensure dashboard reflects any tickets created this session, even if
    // the user navigated to Dashboard only after closing the modal.
    if (window.refreshStatsAndRecent) {
      try { window.refreshStatsAndRecent(); } catch (err) { console.error('refresh failed', err); }
    }
  },

  _resetModal() {
    document.getElementById('composeView').hidden = false;
    document.getElementById('modalPipeline').hidden = true;
    document.getElementById('modalSuccess').hidden = true;
    document.getElementById('modalRunBtn').hidden = false;
    document.getElementById('modalCancelBtn').textContent = 'Close';
    document.getElementById('modalPipelineSteps').innerHTML = '';
    document.getElementById('modalMessage').value = '';
    this.activeTemplateKey = null;
    this._renderTemplates();
  },

  _setSource(source) {
    this.currentSource = source;
    this.modal.querySelectorAll('.source-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === source);
    });
    // Clear message + refresh templates for the new source
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
    root.innerHTML = list
      .map((t, i) => {
        const label = this.currentSource === 'email' ? t.subject : t.body.slice(0, 50) + (t.body.length > 50 ? '…' : '');
        const active = this.activeTemplateKey === t.key ? ' active' : '';
        return `<button type="button" class="tpl-chip${active}" data-key="${t.key}" data-idx="${i}">
          <span class="tpl-chip-icon">${srcIcon}</span>
          <span class="tpl-chip-label">${escapeHtml(label)}</span>
        </button>`;
      })
      .join('');
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
    textarea.value = this.currentSource === 'email'
      ? `Subject: ${tpl.subject}\n\n${tpl.body}`
      : tpl.body;
    this._renderTemplates();
  },

  async run() {
    if (this.running) return;
    const message = document.getElementById('modalMessage').value.trim();
    if (!message) {
      window.toast.show('Pick a template or type a message first', 'warning');
      return;
    }
    this.running = true;
    const runBtn = document.getElementById('modalRunBtn');
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner"></span> Running...';

    // Hide compose, show pipeline
    document.getElementById('composeView').hidden = true;
    document.getElementById('modalPipeline').hidden = false;
    const stepsRoot = document.getElementById('modalPipelineSteps');
    stepsRoot.innerHTML = `<div class="pipeline-step pending visible">
      <div class="step-icon"><span class="spinner"></span></div>
      <div class="step-body"><div class="step-title">Starting pipeline…</div></div>
    </div>`;

    // Strip "Subject: …" prefix for emails if user left it
    let sendMessage = message;
    if (this.currentSource === 'email' && /^subject:/i.test(sendMessage)) {
      const parts = sendMessage.split(/\n\n/);
      if (parts.length >= 2) sendMessage = parts.slice(1).join('\n\n');
    }

    let result;
    try {
      result = await window.api('/api/demo/process', {
        method: 'POST',
        body: JSON.stringify({ message: sendMessage, source: this.currentSource }),
      });
    } catch (err) {
      stepsRoot.innerHTML = `<div class="pipeline-step error visible">
        <div class="step-icon">⚠️</div>
        <div class="step-body">
          <div class="step-title">Pipeline error<span class="step-status error">Error</span></div>
          <div class="step-detail">${escapeHtml(err.message)}</div>
        </div>
      </div>`;
      runBtn.disabled = false;
      runBtn.innerHTML = 'Run Test';
      this.running = false;
      window.toast.show('Pipeline failed — see details', 'error');
      return;
    }

    // Refresh dashboard stats immediately — don't wait for the animation,
    // so the numbers behind the modal are already correct when the user closes it.
    if (window.refreshStatsAndRecent) {
      try { window.refreshStatsAndRecent(); } catch (err) { console.error('refresh failed', err); }
    }

    // Animate steps in
    stepsRoot.innerHTML = '';
    const steps = result.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const el = renderStep(step, true);
      stepsRoot.appendChild(el);
      await sleep(90);
      el.classList.add('visible');
      await sleep(i === 0 ? 120 : 380);
      const finalEl = renderStep(step, false);
      el.replaceWith(finalEl);
      finalEl.classList.add('visible');
    }

    // Show success view
    const ticket = result.ticket || {};
    const mondayUrl = ticket.monday_url;
    document.getElementById('successSummary').innerHTML = `
      <div class="success-kv"><span class="k">Ticket</span><span>${escapeHtml(ticket.ticket_name || '—')}</span></div>
      <div class="success-kv"><span class="k">Property</span><span>${escapeHtml(ticket.property || 'Not matched')}</span></div>
      <div class="success-kv"><span class="k">Urgency</span><span>${urgencyBadgeFor(ticket.urgency)}</span></div>
      <div class="success-kv"><span class="k">Assigned</span><span>${escapeHtml(ticket.assigned_to || '—')}</span></div>
      <div class="success-kv"><span class="k">Flag</span><span>${flagBadgeFor(ticket.flag)}</span></div>
      ${ticket.simulated ? '<div class="success-note">Monday.com isn\'t connected — this ticket was simulated. Add <code>MONDAY_API_KEY</code> in <code>.env</code> to create it on the real board.</div>' : ''}
    `;
    const link = document.getElementById('successMondayLink');
    if (mondayUrl) {
      link.href = mondayUrl;
      link.hidden = false;
    } else {
      link.hidden = true;
    }

    await sleep(280);
    document.getElementById('modalSuccess').hidden = false;
    document.getElementById('modalRunBtn').hidden = true;
    document.getElementById('modalCancelBtn').textContent = 'Done';

    runBtn.disabled = false;
    runBtn.innerHTML = 'Run Test';
    this.running = false;

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
  const statusLabel = pending
    ? 'Running'
    : status === 'success' ? 'Success'
    : status === 'warning' ? 'Warning'
    : status === 'error' ? 'Error'
    : status;
  const detail = pending
    ? '<div class="step-detail"><span class="spinner"></span> Working…</div>'
    : renderStepDetail(step);
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
        ${d.error ? `<div class="kv"><span class="k">Error</span><span class="v">${escapeHtml(d.error)}</span></div>` : ''}
      </div>`;
    case 'match':
      if (d.match) {
        return `<div class="step-detail">
          ${renderKV('Reference', d.reference)}
          ${renderKV('Matched', d.match.name)}
          ${renderKV('Match Type', d.matchType)}
          ${renderKV('Score', d.score)}
          ${renderKV('Address', d.match.address)}
          ${renderKV('Client', d.match.client_name)}
          ${renderKV('Manager', d.match.property_manager)}
          ${d.alternatives?.length ? `<div class="kv"><span class="k">Also considered</span><span class="v">${escapeHtml(d.alternatives.join(', '))}</span></div>` : ''}
        </div>`;
      }
      return `<div class="step-detail">
        ${renderKV('Reference', d.reference)}
        <div class="kv"><span class="k">Result</span><span class="v null-val">No match — ticket flagged for review.</span></div>
      </div>`;
    case 'assign':
      return `<div class="step-detail">
        ${renderKV('Assigned To', d.assignedTo)}
        ${d.escalated ? `<div class="kv"><span class="k">Escalated</span><span class="v">⚡ Urgency escalation</span></div>` : ''}
      </div>`;
    case 'create': {
      const p = d.preview || {};
      return `<div class="step-detail">
        ${d.simulated ? `<div class="kv"><span class="k">Mode</span><span class="v null-val">Simulated (Monday.com not connected)</span></div>` : ''}
        ${d.ticketId ? renderKV('Ticket ID', d.ticketId) : ''}
        ${d.error ? `<div class="kv"><span class="k">API Error</span><span class="v">${escapeHtml(d.error)}</span></div>` : ''}
        <div class="ticket-preview">
          <h4>${escapeHtml(p.name || 'Ticket')}</h4>
          <div class="tp-row"><span class="k">Client</span><span>${escapeHtml(p.clientName || '—')}</span></div>
          <div class="tp-row"><span class="k">Address</span><span>${escapeHtml(p.address || '—')}</span></div>
          <div class="tp-row"><span class="k">Work Type</span><span>${escapeHtml(p.workType || '—')}</span></div>
          <div class="tp-row"><span class="k">Urgency</span><span>${urgencyBadgeFor(p.urgency)}</span></div>
          <div class="tp-row"><span class="k">Manager</span><span>${escapeHtml(p.propertyManager || '—')}</span></div>
          <div class="tp-row"><span class="k">Flag</span><span>${flagBadgeFor(p.flag)}</span></div>
        </div>
      </div>`;
    }
    case 'complete':
      return `<div class="step-detail">
        ${d.ticketId ? renderKV('Ticket ID', d.ticketId) : ''}
        ${d.ticketUrl ? `<div class="kv"><span class="k">Monday URL</span><span class="v"><a href="${d.ticketUrl}" target="_blank" rel="noopener">${escapeHtml(d.ticketUrl)}</a></span></div>` : ''}
        ${d.simulated ? '<div class="kv"><span class="k">Note</span><span class="v null-val">Simulated — no Monday API key set</span></div>' : ''}
        ${renderKV('Confirmation', d.confirmationMessage)}
      </div>`;
  }
  return '<div class="step-detail muted">No details</div>';
}

function urgencyBadgeFor(u) {
  const cls = u === 'asap' ? 'badge-asap' : u === 'urgent' ? 'badge-urgent' : 'badge-normal';
  return `<span class="badge ${cls}">${(u || 'normal').toUpperCase()}</span>`;
}
function flagBadgeFor(f) {
  if (f === 'ok') return `<span class="badge badge-ok">OK</span>`;
  return `<span class="badge badge-needs-review">${(f || 'unknown').replace(/_/g, ' ').toUpperCase()}</span>`;
}

window.demo = demo;
