const VIEW_ORDER = ['guide', 'review', 'taskboard', 'evidence', 'decisions', 'memory', 'console']

const state = {
  view: 'guide',
  running: false,
  snapshot: null,
  taskboard: null,
  inbox: [],
  allPackets: [],
  selectedInboxIndex: -1,
  selectedPacketId: null,
  selectedPacket: null,
  selectedArtifactPath: null,
  evidence: [],
  evidenceById: new Map(),
  decisions: [],
  memoryEntries: [],
  memoryDigest: null,
  activity: [],
  nextAction: null
}

const refs = {
  navButtons: Array.from(document.querySelectorAll('.nav-btn')),
  views: Array.from(document.querySelectorAll('.view')),
  agentStateBadge: document.getElementById('agentStateBadge'),
  runningBadge: document.getElementById('runningBadge'),
  pendingBadge: document.getElementById('pendingBadge'),

  topicInput: document.getElementById('topicInput'),
  startBtn: document.getElementById('startBtn'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),

  refreshBtn: document.getElementById('refreshBtn'),
  nextActionBtn: document.getElementById('nextActionBtn'),
  currentStepTitle: document.getElementById('currentStepTitle'),
  currentStepDesc: document.getElementById('currentStepDesc'),
  workflowSteps: document.getElementById('workflowSteps'),
  summaryProject: document.getElementById('summaryProject'),
  summaryState: document.getElementById('summaryState'),
  summaryTasks: document.getElementById('summaryTasks'),
  summaryPending: document.getElementById('summaryPending'),
  jumpReviewBtn: document.getElementById('jumpReviewBtn'),
  openFirstPendingBtn: document.getElementById('openFirstPendingBtn'),

  inboxCount: document.getElementById('inboxCount'),
  inboxList: document.getElementById('inboxList'),
  packetMeta: document.getElementById('packetMeta'),
  packetView: document.getElementById('packetView'),

  artifactPathInput: document.getElementById('artifactPathInput'),
  openArtifactBtn: document.getElementById('openArtifactBtn'),
  artifactPreview: document.getElementById('artifactPreview'),

  decisionComment: document.getElementById('decisionComment'),
  approveBtn: document.getElementById('approveBtn'),
  changesBtn: document.getElementById('changesBtn'),
  rejectBtn: document.getElementById('rejectBtn'),

  taskboardView: document.getElementById('taskboardView'),
  evidenceTableBody: document.getElementById('evidenceTableBody'),
  decisionsList: document.getElementById('decisionsList'),
  memoryDigestView: document.getElementById('memoryDigestView'),
  memoryList: document.getElementById('memoryList'),
  activityLog: document.getElementById('activityLog')
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(data.error || `Request failed: ${response.status}`)
  }
  return response.json()
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function encodePath(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/')
}

function nowIso() {
  return new Date().toISOString()
}

function isEditableTarget(target) {
  if (!target) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true
    if (target.closest('input, textarea, [contenteditable="true"]')) return true
  }
  return false
}

function withUiError(label, fn) {
  return async () => {
    try {
      await fn()
    } catch (error) {
      addActivity(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function addActivity(line) {
  state.activity.push(`[${nowIso()}] ${line}`)
  state.activity = state.activity.slice(-300)
  refs.activityLog.textContent = state.activity.join('\n')
  refs.activityLog.scrollTop = refs.activityLog.scrollHeight
}

function setView(view) {
  if (!VIEW_ORDER.includes(view)) return
  state.view = view
  for (const btn of refs.navButtons) {
    btn.classList.toggle('active', btn.getAttribute('data-view') === view)
  }
  for (const section of refs.views) {
    section.classList.toggle('active', section.id === `view-${view}`)
  }
}

function setRunning(running) {
  state.running = Boolean(running)
  refs.runningBadge.textContent = state.running ? 'RUNNING' : 'IDLE'
  refs.runningBadge.classList.toggle('muted', !state.running)
  refs.startBtn.disabled = state.running
  refs.sendBtn.disabled = state.running
  updateDecisionButtons()
}

function getTaskCounts() {
  const fallback = { TODO: 0, DOING: 0, BLOCKED: 0, IN_REVIEW: 0, DONE: 0, DROPPED: 0 }
  const tasks = state.snapshot?.status?.tasks
  if (!tasks) return fallback
  return {
    TODO: Number(tasks.TODO || 0),
    DOING: Number(tasks.DOING || 0),
    BLOCKED: Number(tasks.BLOCKED || 0),
    IN_REVIEW: Number(tasks.IN_REVIEW || 0),
    DONE: Number(tasks.DONE || 0),
    DROPPED: Number(tasks.DROPPED || 0)
  }
}

function renderHeaderStatus() {
  const runtimeState = state.snapshot?.status?.state || 'UNKNOWN'
  refs.agentStateBadge.textContent = runtimeState
  refs.pendingBadge.textContent = `pending=${state.inbox.length}`
}

function updateDecisionButtons() {
  const packetPending = Boolean(state.selectedPacket && state.selectedPacket.status === 'pending')
  const disabled = !packetPending || state.running
  refs.approveBtn.disabled = disabled
  refs.changesBtn.disabled = disabled
  refs.rejectBtn.disabled = disabled
}

function computeGuideModel() {
  const counts = getTaskCounts()
  const hasPending = state.inbox.length > 0
  const selectedPending = Boolean(state.selectedPacket && state.selectedPacket.status === 'pending')
  const hasArtifact = Boolean(state.selectedArtifactPath)
  const hasAnyProgress = hasPending || counts.DOING > 0 || counts.IN_REVIEW > 0 || counts.DONE > 0

  const steps = [
    { key: 'start', label: 'Start topic and run first turn', done: hasAnyProgress, status: hasAnyProgress ? 'Completed' : 'Pending' },
    { key: 'wait', label: 'Wait for pending review packet', done: hasPending || selectedPending, status: hasPending ? 'Ready' : state.running ? 'Running' : 'Pending' },
    { key: 'packet', label: 'Open one packet in Review Workspace', done: selectedPending, status: selectedPending ? 'Completed' : hasPending ? 'Ready' : 'Pending' },
    { key: 'artifact', label: 'Inspect at least one artifact', done: selectedPending && hasArtifact, status: selectedPending && hasArtifact ? 'Completed' : selectedPending ? 'Ready' : 'Pending' },
    { key: 'decision', label: 'Approve / Request Changes / Reject', done: Boolean(state.selectedPacket && state.selectedPacket.status !== 'pending'), status: selectedPending ? 'Ready' : 'Pending' },
    { key: 'continue', label: 'Send next-turn guidance', done: false, status: (counts.TODO > 0 || counts.DOING > 0 || counts.BLOCKED > 0) ? 'Ready' : 'Optional' }
  ]

  let guide = null

  if (state.running) {
    guide = {
      title: 'Agent is running, wait for packet generation.',
      desc: 'Keep Console open for runtime events. The packet will appear in Review Workspace when ready.',
      action: { type: 'go_console', label: 'Open Console' },
      stepKey: 'wait'
    }
  } else if (!hasAnyProgress) {
    guide = {
      title: 'Start by entering a concrete topic.',
      desc: 'Use one actionable objective so the first packet is easy to review and decide.',
      action: { type: 'focus_topic', label: 'Focus Topic Input' },
      stepKey: 'start'
    }
  } else if (hasPending && !selectedPending) {
    guide = {
      title: 'Open one pending packet now.',
      desc: 'You should always inspect one packet end-to-end before making a decision.',
      action: { type: 'open_first_pending', label: 'Open First Pending Packet' },
      stepKey: 'packet'
    }
  } else if (selectedPending && !hasArtifact) {
    guide = {
      title: 'Inspect one deliverable or evidence artifact.',
      desc: 'Do not decide yet. Verify artifact content and reproducibility first.',
      action: { type: 'open_first_artifact', label: 'Open First Artifact' },
      stepKey: 'artifact'
    }
  } else if (selectedPending) {
    guide = {
      title: 'Make a decision on the selected packet.',
      desc: 'Approve only if acceptance criteria are met; otherwise request changes with specific feedback.',
      action: { type: 'focus_decision', label: 'Focus Decision Comment' },
      stepKey: 'decision'
    }
  } else {
    guide = {
      title: 'Push the next turn forward.',
      desc: 'Send a short follow-up message so the agent can continue with your intent.',
      action: { type: 'focus_message', label: 'Focus Message Input' },
      stepKey: 'continue'
    }
  }

  return { steps, guide }
}

function renderGuide() {
  const model = computeGuideModel()
  const guide = model.guide
  state.nextAction = guide.action

  refs.currentStepTitle.textContent = guide.title
  refs.currentStepDesc.textContent = guide.desc
  refs.nextActionBtn.textContent = guide.action.label

  refs.workflowSteps.innerHTML = model.steps.map((step, index) => {
    const classes = [
      step.key === guide.stepKey ? 'active' : '',
      step.done ? 'done' : ''
    ].join(' ').trim()

    return `<li class="${classes}">
      <strong>${index + 1}. ${escapeHtml(step.label)}</strong><br>
      <span class="muted">${escapeHtml(step.status)}</span>
    </li>`
  }).join('')

  const counts = getTaskCounts()
  refs.summaryProject.textContent = `Project: ${state.taskboard?.project?.title || '-'}`
  refs.summaryState.textContent = `State: ${state.snapshot?.status?.state || 'UNKNOWN'}${state.running ? ' (running)' : ''}`
  refs.summaryTasks.textContent = `Tasks: TODO ${counts.TODO}, DOING ${counts.DOING}, IN_REVIEW ${counts.IN_REVIEW}, DONE ${counts.DONE}, BLOCKED ${counts.BLOCKED}, DROPPED ${counts.DROPPED}`
  refs.summaryPending.textContent = `Pending packets: ${state.inbox.length}`
}

async function executeNextAction() {
  const action = state.nextAction?.type
  if (!action) return

  if (action === 'focus_topic') {
    setView('guide')
    refs.topicInput.focus()
    refs.topicInput.select()
    return
  }
  if (action === 'focus_message') {
    setView('guide')
    refs.messageInput.focus()
    refs.messageInput.select()
    return
  }
  if (action === 'focus_decision') {
    setView('review')
    refs.decisionComment.focus()
    refs.decisionComment.select()
    return
  }
  if (action === 'open_first_pending') {
    if (state.inbox.length > 0) {
      setView('review')
      await openInboxIndex(0, { source: 'guide' })
    }
    return
  }
  if (action === 'open_first_artifact') {
    const packet = state.selectedPacket
    if (packet && packet.deliverables && packet.deliverables.length > 0) {
      setView('review')
      await openArtifact(packet.deliverables[0].path)
    }
    return
  }
  if (action === 'go_console') {
    setView('console')
  }
}

function normalizeInboxSelection() {
  if (state.inbox.length === 0) {
    state.selectedInboxIndex = -1
    return
  }

  if (state.selectedPacketId) {
    const existingIndex = state.inbox.findIndex((item) => item.packet_id === state.selectedPacketId)
    if (existingIndex >= 0) {
      state.selectedInboxIndex = existingIndex
      return
    }
  }

  if (state.selectedInboxIndex < 0 || state.selectedInboxIndex >= state.inbox.length) {
    state.selectedInboxIndex = 0
  }

  state.selectedPacketId = state.inbox[state.selectedInboxIndex].packet_id
}

function renderInbox() {
  refs.inboxCount.textContent = `${state.inbox.length} pending`

  if (state.inbox.length === 0) {
    refs.inboxList.innerHTML = '<p class="muted">No pending packets.</p>'
    return
  }

  refs.inboxList.innerHTML = state.inbox.map((item, index) => {
    const active = index === state.selectedInboxIndex ? 'active' : ''
    return `<div class="inbox-item ${active}" data-index="${index}">
      <div class="inbox-id">${escapeHtml(item.packet_id)} <span class="muted">${escapeHtml(item.type)}</span></div>
      <div>${escapeHtml(item.title)}</div>
      <div class="inbox-meta">risk=${escapeHtml(item.risk)} | ${escapeHtml(item.scope_summary)}</div>
      <div class="inbox-meta">${escapeHtml(item.ask_summary)}</div>
    </div>`
  }).join('')

  for (const item of refs.inboxList.querySelectorAll('.inbox-item')) {
    item.addEventListener('click', () => {
      const index = Number.parseInt(item.getAttribute('data-index') || '-1', 10)
      if (!Number.isNaN(index)) {
        void openInboxIndex(index, { source: 'click' })
      }
    })
  }
}

function chooseLinkedArtifactPath(packet) {
  const deliverables = packet.deliverables || []
  if (deliverables.length === 0) return null

  if (state.selectedArtifactPath && deliverables.some((item) => item.path === state.selectedArtifactPath)) {
    return state.selectedArtifactPath
  }

  return deliverables[0].path
}

function formatList(items) {
  if (!items || items.length === 0) return '<em class="muted">None</em>'
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

function buildEvidenceList(packet) {
  const refsList = packet.evidence_refs || []
  if (refsList.length === 0) return '<em class="muted">None</em>'

  return `<ul>${refsList.map((eid) => {
    const evidence = state.evidenceById.get(eid)
    if (!evidence) return `<li><code>${escapeHtml(eid)}</code></li>`

    const path = evidence.path || ''
    const actions = path
      ? `<span class="packet-inline-actions">
          <button class="ghost" data-artifact-path="${escapeHtml(path)}">Preview</button>
          <a href="/artifacts/${encodePath(path)}" target="_blank" rel="noreferrer">Raw</a>
        </span>`
      : ''

    return `<li><code>${escapeHtml(eid)}</code> ${escapeHtml(path)} ${actions}</li>`
  }).join('')}</ul>`
}

function renderPacket(packet) {
  state.selectedPacket = packet
  state.selectedPacketId = packet.packet_id

  const idx = state.inbox.findIndex((item) => item.packet_id === packet.packet_id)
  state.selectedInboxIndex = idx

  refs.packetMeta.textContent = `${packet.packet_id} | ${packet.type} | status=${packet.status}`

  const deliverablesHtml = (packet.deliverables || []).map((item) => {
    const activeClass = item.path === state.selectedArtifactPath ? 'active' : ''
    return `<li class="deliverable-item ${activeClass}">
      <code>${escapeHtml(item.path)}</code> (${escapeHtml(item.kind)})
      <span class="packet-inline-actions">
        <button class="ghost" data-artifact-path="${escapeHtml(item.path)}">Preview</button>
        <a href="/artifacts/${encodePath(item.path)}" target="_blank" rel="noreferrer">Raw</a>
      </span>
    </li>`
  }).join('')

  const preflightChecks = (packet.preflight?.checks || []).map((check) => {
    const link = check.log
      ? `<a href="/artifacts/${encodePath(check.log)}" target="_blank" rel="noreferrer">log</a>`
      : '<span class="muted">no log</span>'

    return `<li>${escapeHtml(check.name)}: <strong>${escapeHtml(check.status)}</strong> (${link})</li>`
  }).join('')

  refs.packetView.innerHTML = [
    section('Summary', `<p>${escapeHtml(packet.summary || '')}</p>`),
    section('What Changed', formatList(packet.what_changed || [])),
    section('Deliverables', deliverablesHtml ? `<ul>${deliverablesHtml}</ul>` : '<em class="muted">None</em>'),
    section('Evidence', buildEvidenceList(packet)),
    section('Reproduce', formatList((packet.reproduce && packet.reproduce.commands) || [])),
    section('Preflight', `
      <p>Status: <strong>${escapeHtml(packet.preflight?.status || 'not_run')}</strong></p>
      ${preflightChecks ? `<ul>${preflightChecks}</ul>` : '<em class="muted">No checks</em>'}
    `),
    section('Risks / Unknowns', formatList(packet.risks || [])),
    section('Ask', formatList((packet.ask || []).map((item) => `${item.question}${item.options ? ` [${item.options.join(', ')}]` : ''}`))),
    section('Recommendation', packet.recommendation
      ? `<p>${escapeHtml(packet.recommendation.suggested_user_action)} - ${escapeHtml(packet.recommendation.rationale)}</p>`
      : '<em class="muted">None</em>'),
    section('Rollback', formatList(packet.rollback_plan || []))
  ].join('')

  for (const btn of refs.packetView.querySelectorAll('button[data-artifact-path]')) {
    btn.addEventListener('click', () => {
      const path = btn.getAttribute('data-artifact-path')
      if (path) {
        void openArtifact(path)
      }
    })
  }

  renderInbox()
  updateDecisionButtons()
  renderGuide()
}

function section(title, body) {
  return `<div class="packet-section"><h3>${escapeHtml(title)}</h3>${body}</div>`
}

function clearPacketPanel(message = 'Select a packet from inbox.') {
  state.selectedPacket = null
  refs.packetMeta.textContent = message
  refs.packetView.innerHTML = ''
  updateDecisionButtons()
}

function clearArtifactPanel(message = 'Open a deliverable/evidence artifact to preview.') {
  refs.artifactPreview.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`
}

function renderArtifact(payload, artifactPath) {
  const rawUrl = payload.raw_url || `/artifacts/${encodePath(artifactPath)}`

  if (payload.is_image) {
    refs.artifactPreview.innerHTML = [
      `<div class="artifact-header">Artifact: <code>${escapeHtml(artifactPath)}</code></div>`,
      `<img src="${rawUrl}" alt="${escapeHtml(artifactPath)}">`,
      `<p><a href="${rawUrl}" target="_blank" rel="noreferrer">Open raw</a></p>`
    ].join('')
    return
  }

  refs.artifactPreview.innerHTML = [
    `<div class="artifact-header">Artifact: <code>${escapeHtml(artifactPath)}</code></div>`,
    `<pre>${escapeHtml(payload.preview || '(empty)')}</pre>`,
    `<p><a href="${rawUrl}" target="_blank" rel="noreferrer">Open raw</a></p>`
  ].join('')
}

async function openArtifact(artifactPath, options = {}) {
  const normalized = artifactPath.trim()
  if (!normalized) return

  const payload = await api(`/api/artifact?path=${encodeURIComponent(normalized)}`)
  state.selectedArtifactPath = normalized
  refs.artifactPathInput.value = normalized
  renderArtifact(payload, normalized)

  if (state.selectedPacket) {
    renderPacket(state.selectedPacket)
  }

  if (!options.suppressActivity) {
    addActivity(`Opened artifact ${normalized}`)
  }
}

async function loadPacket(packetId, options = {}) {
  const packet = await api(`/api/packets/${encodeURIComponent(packetId)}`)
  renderPacket(packet)

  if (!options.suppressActivity) {
    addActivity(`Opened packet ${packetId}`)
  }

  if (options.autoArtifact !== false) {
    const linked = chooseLinkedArtifactPath(packet)
    if (linked) {
      await openArtifact(linked, { suppressActivity: true })
    }
  }
}

async function openInboxIndex(index, options = {}) {
  if (state.inbox.length === 0) return

  const clamped = Math.max(0, Math.min(index, state.inbox.length - 1))
  state.selectedInboxIndex = clamped
  state.selectedPacketId = state.inbox[clamped].packet_id
  renderInbox()

  await loadPacket(state.selectedPacketId, {
    autoArtifact: options.autoArtifact !== false,
    suppressActivity: options.suppressActivity ?? false
  })
}

function selectRelativeInbox(step) {
  if (state.inbox.length === 0) return

  if (state.selectedInboxIndex < 0) {
    state.selectedInboxIndex = 0
  } else {
    state.selectedInboxIndex = (state.selectedInboxIndex + step + state.inbox.length) % state.inbox.length
  }

  void openInboxIndex(state.selectedInboxIndex, {
    autoArtifact: true,
    suppressActivity: true
  })
}

async function submitDecision(action) {
  if (!state.selectedPacketId || !state.selectedPacket) {
    addActivity('No packet selected for decision.')
    return
  }

  const comment = refs.decisionComment.value.trim()

  if ((action === 'request_changes' || action === 'reject') && !comment) {
    addActivity('Comment is required for request changes / reject.')
    refs.decisionComment.focus()
    return
  }

  const endpoint = action === 'approve'
    ? 'approve'
    : action === 'request_changes'
      ? 'request-changes'
      : 'reject'

  await api(`/api/packets/${encodeURIComponent(state.selectedPacketId)}/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({ comment })
  })

  addActivity(`Decision applied: ${action} (${state.selectedPacketId})`)
  refs.decisionComment.value = ''
  await refreshAll()

  if (state.inbox.length > 0) {
    setView('review')
    await openInboxIndex(0, { autoArtifact: true, suppressActivity: true })
  }
}

async function startAgent() {
  const topic = refs.topicInput.value.trim()
  if (!topic) {
    addActivity('Topic is required.')
    refs.topicInput.focus()
    return
  }

  await api('/api/agent/start', {
    method: 'POST',
    body: JSON.stringify({ topic })
  })

  setRunning(true)
  addActivity('Agent start requested.')
  setView('console')
}

async function sendMessage() {
  const message = refs.messageInput.value.trim()
  if (!message) {
    addActivity('Message is required.')
    refs.messageInput.focus()
    return
  }

  await api('/api/agent/message', {
    method: 'POST',
    body: JSON.stringify({ message })
  })

  refs.messageInput.value = ''
  setRunning(true)
  addActivity('Agent message requested.')
  setView('console')
}

function renderTaskboard() {
  const board = state.taskboard
  if (!board || !Array.isArray(board.tasks)) {
    refs.taskboardView.innerHTML = '<p class="muted">Taskboard unavailable.</p>'
    return
  }

  const statuses = ['TODO', 'DOING', 'BLOCKED', 'IN_REVIEW', 'DONE', 'DROPPED']
  refs.taskboardView.innerHTML = statuses.map((status) => {
    const tasks = board.tasks.filter((task) => task.status === status)
    return `<section class="task-col">
      <h3>${status} (${tasks.length})</h3>
      ${tasks.map((task) => `<article class="task-card">
        <div class="id">${escapeHtml(task.id)} | ${escapeHtml(task.priority)} | ${escapeHtml(task.owner)}</div>
        <div class="title">${escapeHtml(task.title)}</div>
        <div class="meta">depends_on=${escapeHtml((task.depends_on || []).join(', ') || '-')}</div>
      </article>`).join('') || '<p class="muted">No tasks.</p>'}
    </section>`
  }).join('')
}

function renderEvidence() {
  if (!Array.isArray(state.evidence) || state.evidence.length === 0) {
    refs.evidenceTableBody.innerHTML = '<tr><td colspan="6" class="muted">No evidence records.</td></tr>'
    return
  }

  const rows = [...state.evidence].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))

  refs.evidenceTableBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.eid || '')}</td>
      <td>${escapeHtml(row.type || '')}</td>
      <td>${escapeHtml(row.title || '')}</td>
      <td>${row.path ? `<span class="table-link" data-open-evidence-artifact="${escapeHtml(row.path)}">${escapeHtml(row.path)}</span>` : '-'}</td>
      <td>${row.packet_id ? `<span class="table-link" data-open-evidence-packet="${escapeHtml(row.packet_id)}">${escapeHtml(row.packet_id)}</span>` : '-'}</td>
      <td>${escapeHtml(row.timestamp || '')}</td>
    </tr>
  `).join('')

  for (const element of refs.evidenceTableBody.querySelectorAll('[data-open-evidence-artifact]')) {
    element.addEventListener('click', () => {
      const path = element.getAttribute('data-open-evidence-artifact')
      if (!path) return
      setView('review')
      void withUiError('open artifact from evidence', () => openArtifact(path))()
    })
  }

  for (const element of refs.evidenceTableBody.querySelectorAll('[data-open-evidence-packet]')) {
    element.addEventListener('click', () => {
      const packetId = element.getAttribute('data-open-evidence-packet')
      if (!packetId) return
      setView('review')
      void withUiError('open packet from evidence', () => loadPacket(packetId))()
    })
  }
}

function renderDecisions() {
  if (!Array.isArray(state.decisions) || state.decisions.length === 0) {
    refs.decisionsList.innerHTML = '<p class="muted">No decisions yet.</p>'
    return
  }

  const rows = [...state.decisions].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

  refs.decisionsList.innerHTML = rows.map((row) => `
    <article class="decision-item">
      <div class="title">${escapeHtml(row.decision_id || '-')} | ${escapeHtml(row.action || '-')}</div>
      <div class="meta">packet=${row.packet_id ? `<span class="table-link" data-open-decision-packet="${escapeHtml(row.packet_id)}">${escapeHtml(row.packet_id)}</span>` : '-'} | time=${escapeHtml(row.created_at || '-')}</div>
      <div class="meta">comment=${escapeHtml(row.comment || '(none)')}</div>
      <div class="meta">impacts=${escapeHtml((row.impacts || []).join('; ') || '(none)')}</div>
    </article>
  `).join('')

  for (const element of refs.decisionsList.querySelectorAll('[data-open-decision-packet]')) {
    element.addEventListener('click', () => {
      const packetId = element.getAttribute('data-open-decision-packet')
      if (!packetId) return
      setView('review')
      void withUiError('open packet from decision', () => loadPacket(packetId))()
    })
  }
}

function memoryTypeLabel(type) {
  if (type === 'fact') return 'Fact'
  if (type === 'constraint') return 'Constraint'
  if (type === 'decision') return 'Decision'
  if (type === 'artifact') return 'Artifact'
  if (type === 'risk') return 'Risk'
  if (type === 'question') return 'Question'
  return 'Note'
}

function renderMemoryDigest() {
  const digest = state.memoryDigest
  if (!digest) {
    refs.memoryDigestView.innerHTML = '<p class="muted">No memory digest.</p>'
    return
  }

  const groups = [
    { title: 'Facts', values: digest.latest_facts || [] },
    { title: 'Constraints', values: digest.latest_constraints || [] },
    { title: 'Decisions', values: digest.latest_decisions || [] },
    { title: 'Open Questions', values: digest.open_questions || [] },
    { title: 'Artifacts', values: digest.key_artifacts || [] }
  ]

  refs.memoryDigestView.innerHTML = groups.map((group) => {
    const body = group.values.length > 0
      ? `<ul>${group.values.slice(0, 4).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
      : '<div class="muted">None</div>'

    return `<div class="memory-digest-card">
      <h4>${escapeHtml(group.title)}</h4>
      ${body}
    </div>`
  }).join('')
}

function renderMemoryEntries() {
  if (!Array.isArray(state.memoryEntries) || state.memoryEntries.length === 0) {
    refs.memoryList.innerHTML = '<p class="muted">No memory entries.</p>'
    return
  }

  refs.memoryList.innerHTML = state.memoryEntries.map((entry) => {
    const packetAction = entry.packet_id
      ? `<button class="ghost" data-memory-open-packet="${escapeHtml(entry.packet_id)}">Open Packet</button>`
      : ''

    const artifactPath = Array.isArray(entry.evidence_paths) && entry.evidence_paths.length > 0
      ? String(entry.evidence_paths[0] || '')
      : ''

    const artifactAction = artifactPath
      ? `<button class="ghost" data-memory-open-artifact="${escapeHtml(artifactPath)}">Open Artifact</button>`
      : ''

    return `<article class="memory-item">
      <div class="memory-item-top">
        <span class="memory-type type-${escapeHtml(entry.type)}">${escapeHtml(memoryTypeLabel(entry.type))}</span>
        <span class="muted">${escapeHtml(entry.id)} | ${escapeHtml(entry.created_at)}</span>
      </div>
      <div class="memory-text">${escapeHtml(entry.text || '')}</div>
      <div class="memory-actions">
        ${packetAction}
        ${artifactAction}
      </div>
    </article>`
  }).join('')

  for (const btn of refs.memoryList.querySelectorAll('[data-memory-open-packet]')) {
    btn.addEventListener('click', () => {
      const packetId = btn.getAttribute('data-memory-open-packet')
      if (!packetId) return
      setView('review')
      void withUiError('open memory packet', () => loadPacket(packetId))()
    })
  }

  for (const btn of refs.memoryList.querySelectorAll('[data-memory-open-artifact]')) {
    btn.addEventListener('click', () => {
      const artifactPath = btn.getAttribute('data-memory-open-artifact')
      if (!artifactPath) return
      setView('review')
      void withUiError('open memory artifact', () => openArtifact(artifactPath))()
    })
  }
}

function renderMemory() {
  renderMemoryDigest()
  renderMemoryEntries()
}

let refreshScheduled = false

function scheduleRefresh() {
  if (refreshScheduled) return
  refreshScheduled = true

  setTimeout(() => {
    refreshScheduled = false
    void withUiError('scheduled refresh', refreshAll)()
  }, 180)
}

async function refreshAll() {
  const [snapshot, taskboard, packetsPayload, evidence, memory, decisions] = await Promise.all([
    api('/api/state'),
    api('/api/taskboard'),
    api('/api/packets?all=1'),
    api('/api/evidence'),
    api('/api/memory?limit=120&digest=8'),
    api('/api/decisions')
  ])

  state.snapshot = snapshot
  state.taskboard = taskboard
  state.inbox = packetsPayload.pending || []
  state.allPackets = packetsPayload.all || []
  state.evidence = evidence || []
  state.evidenceById = new Map((state.evidence || []).map((item) => [item.eid, item]))
  state.decisions = decisions || []
  state.memoryEntries = memory.entries || []
  state.memoryDigest = memory.digest || null

  setRunning(Boolean(snapshot.running))
  renderHeaderStatus()

  normalizeInboxSelection()
  renderInbox()
  renderTaskboard()
  renderEvidence()
  renderDecisions()
  renderMemory()
  renderGuide()

  if (!state.selectedPacketId && state.inbox.length > 0) {
    state.selectedPacketId = state.inbox[0].packet_id
    state.selectedInboxIndex = 0
  }

  if (state.selectedPacketId) {
    try {
      await loadPacket(state.selectedPacketId, {
        suppressActivity: true,
        autoArtifact: false
      })

      if (!state.selectedArtifactPath && state.selectedPacket) {
        const linked = chooseLinkedArtifactPath(state.selectedPacket)
        if (linked) {
          await openArtifact(linked, { suppressActivity: true })
        }
      }
    } catch (error) {
      clearPacketPanel(`Packet unavailable: ${String(error)}`)
      clearArtifactPanel()
    }
  } else {
    clearPacketPanel()
    clearArtifactPanel()
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

  ws.onopen = () => addActivity('WebSocket connected.')

  ws.onerror = () => addActivity('WebSocket error.')

  ws.onclose = () => {
    addActivity('WebSocket disconnected; retrying in 2s.')
    setTimeout(connectWebSocket, 2000)
  }

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data)

      if (payload.type === 'snapshot') {
        state.snapshot = payload.data || state.snapshot
        setRunning(Boolean(payload.data?.running))
        renderHeaderStatus()
        renderGuide()
        return
      }

      addActivity(`${payload.type}: ${JSON.stringify(payload.data || {})}`)
      scheduleRefresh()
    } catch (error) {
      addActivity(`WebSocket parse error: ${String(error)}`)
    }
  }
}

function attachKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    const editing = isEditableTarget(document.activeElement)

    if (editing && key !== 'escape') return

    if (key >= '1' && key <= '7') {
      const index = Number.parseInt(key, 10) - 1
      const view = VIEW_ORDER[index]
      if (view) {
        event.preventDefault()
        setView(view)
      }
      return
    }

    if (key === 'j') {
      event.preventDefault()
      setView('review')
      selectRelativeInbox(1)
      return
    }

    if (key === 'k') {
      event.preventDefault()
      setView('review')
      selectRelativeInbox(-1)
      return
    }

    if (key === 'o' || key === 'enter') {
      event.preventDefault()
      if (state.selectedPacketId) {
        setView('review')
        void withUiError('open packet', () => loadPacket(state.selectedPacketId))()
      }
      return
    }

    if (key === 'a') {
      event.preventDefault()
      setView('review')
      void withUiError('approve', () => submitDecision('approve'))()
      return
    }

    if (key === 'c') {
      event.preventDefault()
      setView('review')
      void withUiError('request changes', () => submitDecision('request_changes'))()
      return
    }

    if (key === 'x') {
      event.preventDefault()
      setView('review')
      void withUiError('reject', () => submitDecision('reject'))()
      return
    }

    if (key === '/') {
      event.preventDefault()
      setView('review')
      refs.artifactPathInput.focus()
      refs.artifactPathInput.select()
      return
    }

    if (key === 'n') {
      event.preventDefault()
      void withUiError('next action', executeNextAction)()
      return
    }

    if (key === 's') {
      event.preventDefault()
      setView('guide')
      refs.topicInput.focus()
      refs.topicInput.select()
      return
    }

    if (key === 'm') {
      event.preventDefault()
      setView('guide')
      refs.messageInput.focus()
      refs.messageInput.select()
      return
    }

    if (key === 'r') {
      event.preventDefault()
      void withUiError('refresh', refreshAll)()
      return
    }

    if (key === 'y') {
      event.preventDefault()
      setView('memory')
    }
  })
}

refs.navButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.getAttribute('data-view')
    if (view) setView(view)
  })
})

refs.startBtn.addEventListener('click', () => void withUiError('start agent', startAgent)())
refs.sendBtn.addEventListener('click', () => void withUiError('send message', sendMessage)())
refs.refreshBtn.addEventListener('click', () => void withUiError('refresh', refreshAll)())
refs.nextActionBtn.addEventListener('click', () => void withUiError('next action', executeNextAction)())
refs.jumpReviewBtn.addEventListener('click', () => setView('review'))
refs.openFirstPendingBtn.addEventListener('click', () => {
  if (state.inbox.length === 0) {
    addActivity('No pending packet to open.')
    return
  }
  setView('review')
  void withUiError('open first pending', () => openInboxIndex(0))()
})

refs.openArtifactBtn.addEventListener('click', () => {
  const path = refs.artifactPathInput.value.trim()
  if (!path) {
    addActivity('Artifact path is required.')
    refs.artifactPathInput.focus()
    return
  }
  void withUiError('open artifact', () => openArtifact(path))()
})

refs.approveBtn.addEventListener('click', () => void withUiError('approve', () => submitDecision('approve'))())
refs.changesBtn.addEventListener('click', () => void withUiError('request changes', () => submitDecision('request_changes'))())
refs.rejectBtn.addEventListener('click', () => void withUiError('reject', () => submitDecision('reject'))())

attachKeyboardShortcuts()
updateDecisionButtons()
clearArtifactPanel()
void withUiError('initial refresh', refreshAll)().then(() => {
  addActivity('UI ready.')
})
connectWebSocket()
