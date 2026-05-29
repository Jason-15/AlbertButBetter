'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let allCourses = [];       // Fall courses from API
let specializations = [];
let specColorMap = {};
let programData = {};      // { semesters: [...] }

// Filters
let filterSearch = '';
let filterDays = new Set();
let filterSession = '';
let filterSpec = '';
let filterCredits = new Set();
let showNotInterested = false;

// Current semester being browsed / scheduled
let currentBrowserSem = 'fall_2026';
let currentSchedSem   = 'fall_2026';

// Inline edits pending save
const pendingSaves = new Map();  // code → timeout id

// Spec assignment: code → spec name (which spec this course's credits count toward)
// Starts as greedy auto-assignment; user can override per-course
let manualSpecOverrides = {};
try { manualSpecOverrides = JSON.parse(localStorage.getItem('specOverrides') || '{}'); } catch(e) {}
const SPEC_GOAL = 9;


// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const data = await apiFetch('/api/courses');
  if (!data) return;

  specializations = data.specializations || [];
  allCourses = data.courses || [];
  programData = data.program || { semesters: [] };

  buildSpecColorMap();
  populateSessionFilter();
  populateSpecFilter();
  wireUpSemesterTabs();
  renderSummerPanel();
  renderSpringPanel();

  const scraped = data.scraped_at
    ? new Date(data.scraped_at).toLocaleDateString()
    : null;
  if (scraped) {
    document.getElementById('header-subtitle').textContent =
      `NYU Stern MBA · scraped ${scraped}`;
  }

  render();
}


// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (res.status === 401) { window.location = '/login'; return null; }
    return await res.json();
  } catch (e) {
    console.error('fetch error', e);
    return null;
  }
}

function saveStatus(code, status) {
  const existing = pendingSaves.get(code);
  if (existing) clearTimeout(existing);
  const tid = setTimeout(async () => {
    pendingSaves.delete(code);
    await apiFetch(`/api/courses/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  }, 300);
  pendingSaves.set(code, tid);
}

function saveNotes(code, notes) {
  const existing = pendingSaves.get(code + ':notes');
  if (existing) clearTimeout(existing);
  const tid = setTimeout(async () => {
    pendingSaves.delete(code + ':notes');
    await apiFetch(`/api/courses/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
  }, 600);
  pendingSaves.set(code + ':notes', tid);
}


// ── Color map ─────────────────────────────────────────────────────────────────

function buildSpecColorMap() {
  specializations.forEach((spec, i) => {
    specColorMap[spec] = `var(--c${i % 16})`;
  });
}

function specColor(spec) {
  return specColorMap[spec] || 'var(--text-dim)';
}


// ── Filters ───────────────────────────────────────────────────────────────────

function populateSessionFilter() {
  const sessions = [...new Set(allCourses.map(c => c.session).filter(Boolean))].sort();
  const sel = document.getElementById('filter-session');
  sessions.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

function populateSpecFilter() {
  const sel = document.getElementById('filter-spec');
  specializations.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

function filteredCourses() {
  const q = filterSearch.toLowerCase();
  const conflictSet = getConflicts();

  return allCourses.filter(c => {
    // Prior and spring core courses never appear in the fall/spring browser
    if (c.prior || c.spring_core) return false;

    // Semester filter: fall tab shows fall courses; spring tab shows spring-eligible courses
    if (currentBrowserSem === 'spring_2027' && !c.also_spring) return false;
    if (currentBrowserSem === 'fall_2026' && c.semester === 'spring_2027') return false;

    // Not-interested visibility
    if (!showNotInterested && c.status === 'not_interested') return false;

    // Text search
    if (q) {
      const haystack = [c.code, c.title, ...(c.instructors || [])].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    // Day filter
    if (filterDays.size > 0) {
      const courseDays = new Set((c.meetings || []).flatMap(m => m.days || []));
      if (![...filterDays].some(d => courseDays.has(d))) return false;
    }

    // Session filter
    if (filterSession && c.session !== filterSession) return false;

    // Spec filter
    if (filterSpec && !(c.specializations || []).includes(filterSpec)) return false;

    // Credits filter
    if (filterCredits.size > 0 && !filterCredits.has(String(c.credits))) return false;

    return true;
  }).map(c => ({ ...c, _conflict: conflictSet.has(c.code) }));
}


// ── Conflict detection ────────────────────────────────────────────────────────

function parseMins(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function meetingsOverlap(meetingsA, meetingsB) {
  for (const a of meetingsA || []) {
    for (const b of meetingsB || []) {
      const sharedDay = (a.days || []).some(d => (b.days || []).includes(d));
      if (!sharedDay) continue;
      const aStart = parseMins(a.start_time);
      const aEnd   = parseMins(a.end_time);
      const bStart = parseMins(b.start_time);
      const bEnd   = parseMins(b.end_time);
      if (aStart !== null && aEnd !== null && bStart !== null && bEnd !== null) {
        if (aStart < bEnd && bStart < aEnd) return true;
      }
    }
  }
  return false;
}

function getConflicts() {
  const planned = allCourses.filter(c => c.status === 'planned');
  const conflicts = new Set();
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      if (meetingsOverlap(planned[i].meetings, planned[j].meetings)) {
        conflicts.add(planned[i].code);
        conflicts.add(planned[j].code);
      }
    }
  }
  return conflicts;
}


// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const visible = filteredCourses();
  renderCourseList(visible);
  renderPlanBoard();
  renderSpecTracker();
  renderStats();
}

function formatMeetings(meetings) {
  if (!meetings || meetings.length === 0) return 'TBD';
  return meetings.map(m => {
    const days = (m.days || []).join('/');
    const time = (m.start_time && m.end_time)
      ? ` ${fmtTime(m.start_time)}–${fmtTime(m.end_time)}`
      : '';
    return days + time;
  }).join(', ');
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 || 12;
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2,'0')}${ampm}`;
}

function renderCourseList(courses) {
  const container = document.getElementById('course-list');
  document.getElementById('results-count').textContent =
    `${courses.length} course${courses.length !== 1 ? 's' : ''} shown`;

  container.innerHTML = '';
  if (courses.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim);font-style:italic;padding:.5rem">No courses match your filters.</p>';
    return;
  }

  for (const c of courses) {
    container.appendChild(buildCourseCard(c));
  }
}

function buildCourseCard(c) {
  const specs = c.specializations || [];
  const isPlanned = c.status === 'planned';
  const isNope    = c.status === 'not_interested';

  const card = document.createElement('div');
  card.className = [
    'course-card',
    isPlanned ? 'status-planned' : '',
    isNope    ? 'status-not-interested' : '',
    c._conflict ? 'has-conflict' : '',
  ].filter(Boolean).join(' ');
  card.dataset.code = c.code;

  // Left border: first spec color (or gradient if multi-spec)
  if (specs.length === 1) {
    card.style.borderLeftColor = specColor(specs[0]);
  } else if (specs.length > 1) {
    const colors = specs.slice(0, 3).map(specColor).join(', ');
    card.style.borderImage = `linear-gradient(180deg, ${colors}) 1`;
  }

  const plannedForSpring = c.status === 'planned' && c.semester === 'spring_2027';
  const plannedForFall   = c.status === 'planned' && c.semester === 'fall_2026';

  card.innerHTML = `
    <div class="card-top">
      <span class="card-code">${esc(c.code)}</span>
      ${c.required ? '<span class="required-badge">Required</span>' : ''}
      ${specs.length > 1 ? '<span class="multi-badge">multi-spec</span>' : ''}
      ${plannedForSpring && currentBrowserSem === 'fall_2026' ? '<span class="spring-badge">→ Spring</span>' : ''}
      ${plannedForFall   && currentBrowserSem === 'spring_2027' ? '<span class="spring-badge">in Fall</span>' : ''}
    </div>
    <div class="card-title">${esc(c.title)}</div>
    <div class="card-meta">
      <span class="meta-item">${esc(formatMeetings(c.meetings))}${c._conflict ? ' <span class="conflict-icon" title="Time conflict in plan">⚠</span>' : ''}</span>
      <span class="meta-item">${c.credits ? c.credits + ' cr' : ''}</span>
      <span class="meta-item">${esc(c.session || '')}</span>
      ${c.instruction_mode ? `<span class="meta-item">${esc(c.instruction_mode)}</span>` : ''}
      ${c.last_offered ? `<span class="meta-item">Last: ${esc(Array.isArray(c.last_offered) ? c.last_offered.join(', ') : c.last_offered)}</span>` : ''}
    </div>
    <div class="spec-badges">
      ${specs.map(s => `<span class="spec-badge" style="background:${specColor(s)}">${esc(s)}</span>`).join('')}
    </div>
    <div class="card-actions">
      <button class="btn btn-plan ${isPlanned ? 'planned' : ''}" data-action="toggle-plan">
        ${isPlanned ? '✓ Planned' : '+ Plan'}
      </button>
      <button class="btn btn-nope ${isNope ? 'active' : ''}" data-action="toggle-nope">
        ${isNope ? 'Undo' : 'Not interested'}
      </button>
    </div>
  `;

  card.querySelector('[data-action="toggle-plan"]').addEventListener('click', () => togglePlan(c.code));
  card.querySelector('[data-action="toggle-nope"]')?.addEventListener('click', () => toggleNope(c.code));

  return card;
}

function renderPlanBoard() {
  const planned = allCourses.filter(c => c.status === 'planned' && !c.prior && !c.spring_core);
  const conflicts = getConflicts();
  const container = document.getElementById('plan-list');
  container.innerHTML = '';

  if (planned.length === 0) {
    container.innerHTML = '<p class="empty-hint">Add courses to start planning.</p>';
    return;
  }

  // Group by semester
  const bySem = {};
  for (const c of planned) {
    const sem = c.semester || 'fall_2026';
    if (!bySem[sem]) bySem[sem] = [];
    bySem[sem].push(c);
  }

  const semLabels = { fall_2026: 'Fall 2026', spring_2027: 'Spring 2027 (electives)' };
  const semOrder = ['fall_2026', 'spring_2027'];
  const sortedSems = semOrder.filter(s => bySem[s]);

  for (const semId of sortedSems) {
    const courses = bySem[semId];
    if (sortedSems.length > 1) {
      const lbl = document.createElement('div');
      lbl.className = `plan-sem-label${semId === 'summer_2026' ? ' plan-sem-completed' : ''}`;
      lbl.textContent = semLabels[semId] || semId;
      container.appendChild(lbl);
    }
    for (const c of courses) {
      const item = document.createElement('div');
      item.className = `plan-item ${conflicts.has(c.code) ? 'conflict' : ''}`;
      item.innerHTML = `
        <div class="plan-item-body">
          <div class="plan-item-code">${esc(c.code)}${c.required ? ' <span class="required-badge" style="font-size:0.58rem">REQ</span>' : ''}</div>
          <div class="plan-item-title" title="${esc(c.title)}">${esc(c.title)}</div>
          <div class="plan-item-time">${esc(formatMeetings(c.meetings))}${conflicts.has(c.code) ? ' ⚠ conflict' : ''}</div>
          ${c.credits ? `<div class="plan-item-credits">${c.credits} cr</div>` : ''}
        </div>
        <button class="plan-item-remove" title="Remove from plan">×</button>
      `;
      item.querySelector('.plan-item-remove').addEventListener('click', () => togglePlan(c.code));
      container.appendChild(item);
    }
  }
}

// ── Spec assignment ───────────────────────────────────────────────────────────

function computeSpecAssignment(planned) {
  // Start from manual overrides; only override valid spec+course combos
  const assignment = {};
  for (const [code, spec] of Object.entries(manualSpecOverrides)) {
    const course = planned.find(c => c.code === code);
    if (course && (course.specializations || []).includes(spec)) {
      assignment[code] = spec;
    }
  }

  // Pass 1 – exclusive courses (only one spec, no choice)
  for (const c of planned) {
    if (assignment[c.code]) continue;
    const specs = (c.specializations || []).filter(s => specializations.includes(s));
    if (specs.length === 1) assignment[c.code] = specs[0];
  }

  // Running credit totals to guide greedy
  const specCredits = {};
  for (const spec of specializations) specCredits[spec] = 0;
  for (const c of planned) {
    if (assignment[c.code]) specCredits[assignment[c.code]] += (c.credits || 0);
  }

  // Pass 2 – shared courses, most-constrained first (fewest spec options)
  const shared = planned
    .filter(c => !assignment[c.code] && (c.specializations || []).filter(s => specializations.includes(s)).length > 1)
    .sort((a, b) => a.specializations.length - b.specializations.length);

  for (const c of shared) {
    const specs = (c.specializations || []).filter(s => specializations.includes(s));
    const cr = c.credits || 0;
    // Among specs still below goal, pick the one closest to goal (most credits banked)
    const needy = specs.filter(s => specCredits[s] < SPEC_GOAL);
    const pool = needy.length ? needy : specs;
    const best = pool.reduce((a, b) => specCredits[a] >= specCredits[b] ? a : b);
    assignment[c.code] = best;
    specCredits[best] += cr;
  }

  return assignment;
}

function getSpecCredits(planned, assignment) {
  const credits = {};
  for (const spec of specializations) credits[spec] = 0;
  for (const c of planned) {
    const s = assignment[c.code];
    if (s) credits[s] += (c.credits || 0);
  }
  return credits;
}

function renderSpecTracker() {
  const planned = allCourses.filter(c => c.status === 'planned');
  const container = document.getElementById('spec-rows');
  container.innerHTML = '';

  const assignment = computeSpecAssignment(planned);
  const specCredits = getSpecCredits(planned, assignment);

  // Only render specs that have at least one planned course in them
  const activeSpecs = specializations.filter(spec =>
    planned.some(c => (c.specializations || []).includes(spec))
  );

  if (!activeSpecs.length) {
    container.innerHTML = '<p class="empty-hint">Add courses to see specialization progress.</p>';
    return;
  }

  // Header row with auto-assign button
  const hdr = document.createElement('div');
  hdr.className = 'spec-assign-header';
  const completed = activeSpecs.filter(s => specCredits[s] >= SPEC_GOAL).length;
  hdr.innerHTML = `
    <span class="spec-assign-summary">${completed} of ${activeSpecs.length} completeable (≥${SPEC_GOAL} cr)</span>
    <button class="spec-assign-btn" id="btn-auto-assign" title="Re-run greedy optimizer">Auto-assign</button>
  `;
  container.appendChild(hdr);
  container.querySelector('#btn-auto-assign').addEventListener('click', () => {
    manualSpecOverrides = {};
    localStorage.setItem('specOverrides', '{}');
    renderSpecTracker();
    renderStats();
  });

  // Sort: complete specs first, then by credits desc
  const sorted = [...activeSpecs].sort((a, b) => {
    const aComp = specCredits[a] >= SPEC_GOAL;
    const bComp = specCredits[b] >= SPEC_GOAL;
    if (aComp !== bComp) return bComp - aComp;
    return specCredits[b] - specCredits[a];
  });

  for (const spec of sorted) {
    const cr = specCredits[spec];
    const isComplete = cr >= SPEC_GOAL;
    const pct = Math.min(100, (cr / SPEC_GOAL) * 100);
    const color = isComplete ? '#22863a' : specColor(spec);
    const crLabel = cr % 1 === 0 ? cr : cr.toFixed(1);

    // All planned courses that belong to this spec
    const inSpec = planned.filter(c => (c.specializations || []).includes(spec));

    const row = document.createElement('div');
    row.className = `spec-row${isComplete ? ' spec-row-complete' : ''}`;
    row.innerHTML = `
      <div class="spec-row-header">
        <span class="spec-row-name" title="${esc(spec)}">${isComplete ? '✓ ' : ''}${esc(spec)}</span>
        <span class="spec-row-count">${crLabel} / ${SPEC_GOAL} cr</span>
      </div>
      <div class="spec-bar-bg">
        <div class="spec-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="spec-chips"></div>
    `;
    const chips = row.querySelector('.spec-chips');

    for (const c of inSpec) {
      const assignedTo = assignment[c.code];
      const isShared = (c.specializations || []).length > 1;
      const countingHere = assignedTo === spec;

      const chip = document.createElement('span');
      chip.className = `spec-chip${isShared ? (countingHere ? ' counting' : ' elsewhere') : ''}`;
      chip.title = countingHere
        ? `${c.title} — credits counting here (${c.credits} cr)${isShared ? '\nClick to assign elsewhere' : ''}`
        : `${c.title} — credits counting toward "${assignedTo}" (${c.credits} cr)\nClick to count here instead`;
      chip.textContent = shortSpecCode(c.code);

      if (isShared) {
        if (!countingHere) {
          const lbl = document.createElement('span');
          lbl.className = 'chip-elsewhere-label';
          lbl.textContent = `→ ${assignedTo ? assignedTo.split(' ')[0] : '?'}`;
          chip.appendChild(lbl);
          chip.addEventListener('click', () => {
            manualSpecOverrides[c.code] = spec;
            localStorage.setItem('specOverrides', JSON.stringify(manualSpecOverrides));
            renderSpecTracker();
            renderStats();
          });
        } else if (Object.keys(manualSpecOverrides).length > 0 && manualSpecOverrides[c.code]) {
          chip.addEventListener('click', () => {
            delete manualSpecOverrides[c.code];
            localStorage.setItem('specOverrides', JSON.stringify(manualSpecOverrides));
            renderSpecTracker();
            renderStats();
          });
        }
      }

      chips.appendChild(chip);
    }

    container.appendChild(row);
  }
}

function shortSpecCode(code) {
  const m = code.match(/^([A-Z]+)-[A-Z]+\.(\d+)/);
  return m ? `${m[1]} ${m[2]}` : code;
}

function renderStats() {
  const sem = currentBrowserSem === 'spring_2027' ? 'spring_2027' : 'fall_2026';
  const planned = allCourses.filter(c =>
    c.status === 'planned' && !c.prior && !c.spring_core && c.semester === sem
  );
  const totalCredits = planned.reduce((s, c) => s + (c.credits || 0), 0);

  const allPlanned = allCourses.filter(c => c.status === 'planned');
  const assignment = computeSpecAssignment(allPlanned);
  const specCredits = getSpecCredits(allPlanned, assignment);
  const completedSpecs = specializations.filter(s => specCredits[s] >= SPEC_GOAL).length;

  document.getElementById('stat-credits').textContent = totalCredits % 1 === 0
    ? totalCredits
    : totalCredits.toFixed(1);
  document.getElementById('stat-courses').textContent = planned.length;
  document.getElementById('stat-specs').textContent = completedSpecs;
}


// ── Actions ───────────────────────────────────────────────────────────────────

function togglePlan(code) {
  const course = allCourses.find(c => c.code === code);
  if (!course) return;
  const wasPlanned = course.status === 'planned';
  course.status = wasPlanned ? 'default' : 'planned';
  if (!wasPlanned) {
    // Assign semester based on which browser tab is active
    course.semester = currentBrowserSem === 'spring_2027' ? 'spring_2027' : 'fall_2026';
  }
  savePlan(code, course.status, course.semester);
  render();
}

function savePlan(code, status, semester) {
  const existing = pendingSaves.get(code);
  if (existing) clearTimeout(existing);
  const tid = setTimeout(async () => {
    pendingSaves.delete(code);
    await apiFetch(`/api/courses/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, semester }),
    });
  }, 300);
  pendingSaves.set(code, tid);
}

function toggleNope(code) {
  const course = allCourses.find(c => c.code === code);
  if (!course) return;
  course.status = course.status === 'not_interested' ? 'default' : 'not_interested';
  saveStatus(code, course.status);
  render();
}


// ── Event wiring ──────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

document.getElementById('search').addEventListener('input', debounce(e => {
  filterSearch = e.target.value.trim();
  render();
}, 200));

document.querySelectorAll('.credit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cr = btn.dataset.credits;
    if (filterCredits.has(cr)) { filterCredits.delete(cr); btn.classList.remove('active'); }
    else                        { filterCredits.add(cr);    btn.classList.add('active');    }
    render();
  });
});

document.querySelectorAll('.day-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const day = btn.dataset.day;
    if (filterDays.has(day)) { filterDays.delete(day); btn.classList.remove('active'); }
    else                      { filterDays.add(day);    btn.classList.add('active');    }
    render();
  });
});

document.getElementById('filter-session').addEventListener('change', e => {
  filterSession = e.target.value;
  render();
});

document.getElementById('filter-spec').addEventListener('change', e => {
  filterSpec = e.target.value;
  render();
});

document.getElementById('toggle-nope').addEventListener('click', function() {
  showNotInterested = !showNotInterested;
  this.classList.toggle('active', showNotInterested);
  this.textContent = showNotInterested ? 'Hide Not Interested' : 'Show Not Interested';
  render();
});

// ── View switching ────────────────────────────────────────────────────────────

let currentView = 'planner';

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`.view-tab[data-view="${name}"]`).classList.add('active');
  if (name === 'schedule') renderSchedule();
}

document.querySelectorAll('.view-tab').forEach(tab => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
});


// ── Semester tab wiring ───────────────────────────────────────────────────────

function wireUpSemesterTabs() {
  document.querySelectorAll('.sem-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentBrowserSem = tab.dataset.sem;
      document.querySelectorAll('.sem-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const isSummer = currentBrowserSem === 'summer_2026';
      const isSpring = currentBrowserSem === 'spring_2027';

      document.getElementById('browser-summer').classList.toggle('active', isSummer);
      document.getElementById('browser-course-view').classList.toggle('hidden', isSummer);
      document.getElementById('spring-core-bar').classList.toggle('visible', isSpring);

      if (!isSummer) render();
    });
  });

  // Schedule semester tabs
  document.querySelectorAll('.sched-sem-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentSchedSem = tab.dataset.sem;
      document.querySelectorAll('.sched-sem-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderSchedule();
    });
  });
}

function renderSummerPanel() {
  const prior = allCourses.filter(c => c.prior);
  const container = document.getElementById('summer-completed-list');
  container.innerHTML = '';

  const core = prior.filter(c => !c.specializations || c.specializations.length === 0);
  const electives = prior.filter(c => c.specializations && c.specializations.length > 0);

  const totalCr = prior.reduce((s, c) => s + (c.credits || 0), 0);

  // Summary header
  const hdr = document.createElement('div');
  hdr.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.25rem">
      <span style="font-size:.88rem;font-weight:600;color:var(--text)">Summer 2026 — Completed</span>
      <span class="summer-completed-badge">✓ done</span>
    </div>
    <div style="font-size:.72rem;color:var(--text-dim);margin-bottom:.75rem">${prior.length} courses · ${totalCr.toFixed(2).replace(/\.?0+$/, '')} cr</div>
  `;
  container.appendChild(hdr);

  // Core courses (no specs)
  if (core.length) {
    const lbl = document.createElement('div');
    lbl.className = 'summer-section-header';
    lbl.textContent = 'Core / Required';
    container.appendChild(lbl);
    for (const c of core) {
      container.appendChild(buildSummerRow(c, false));
    }
  }

  // Elective courses (have specs — assignable)
  if (electives.length) {
    const lbl = document.createElement('div');
    lbl.className = 'summer-section-header';
    lbl.textContent = 'Electives — assign specialization';
    container.appendChild(lbl);
    for (const c of electives) {
      container.appendChild(buildSummerRow(c, true));
    }
  }
}

function buildSummerRow(c, showSpecAssign) {
  const row = document.createElement('div');
  row.className = `summer-course-row${showSpecAssign ? '' : ' core-row'}`;

  const assigned = manualSpecOverrides[c.code] || null;
  // Auto-assign default: first spec
  const autoDefault = (c.specializations || [])[0] || null;
  const currentSpec = assigned || autoDefault;

  let specHtml = '';
  if (showSpecAssign && c.specializations.length > 0) {
    const opts = c.specializations.map(s =>
      `<option value="${esc(s)}" ${currentSpec === s ? 'selected' : ''}>${esc(s)}</option>`
    ).join('');
    specHtml = `
      <div class="summer-spec-assign">
        <select class="summer-spec-select" data-code="${esc(c.code)}">
          ${opts}
        </select>
      </div>
    `;
  }

  row.innerHTML = `
    <div class="summer-course-info">
      <div class="summer-course-code">${esc(c.code)}</div>
      <div class="summer-course-title">${esc(c.title)}</div>
      <div class="summer-course-cr">${c.credits} cr</div>
    </div>
    ${specHtml}
  `;

  if (showSpecAssign) {
    row.querySelector('.summer-spec-select')?.addEventListener('change', e => {
      manualSpecOverrides[c.code] = e.target.value;
      localStorage.setItem('specOverrides', JSON.stringify(manualSpecOverrides));
      renderSpecTracker();
      renderStats();
    });
  }

  return row;
}

function renderSpringPanel() {
  const sem = (programData.semesters || []).find(s => s.id === 'spring_2027');
  if (!sem) return;

  const coreEl = document.getElementById('spring-core-section');
  const coreItems = (sem.core_courses || []);
  const coreCredits = coreItems.reduce((s, c) => s + (c.credits || 0), 0);
  const electiveCredits = (sem.credit_target || 0) - coreCredits;

  coreEl.innerHTML = `
    <div class="spring-core-header">
      Required core — ${coreCredits} cr · ${electiveCredits} elective credits to plan below
    </div>
    <div class="spring-core-list">
      ${coreItems.map(c => `
        <div class="spring-core-item">
          <span class="spring-core-title">${esc(c.title)}</span>
          <span class="spring-core-meta">
            ${c.note ? `<span class="spring-core-note">${esc(c.note)}</span>` : ''}
            <span class="spring-core-cr">${c.credits} cr</span>
            <span class="required-badge">Required</span>
          </span>
        </div>
      `).join('')}
    </div>
  `;
}


// ── Schedule view ─────────────────────────────────────────────────────────────

const CAL_START_H = 8;   // 8 am
const CAL_END_H   = 22;  // 10 pm
const PX_PER_H    = 70;
const DAYS_ORDER  = ['Mon','Tue','Wed','Thu','Fri'];

function sessionClass(session) {
  const s = (session || '').toLowerCase();
  if (s.includes('1st half') || s.includes('first half')) return 'session-1half';
  if (s.includes('2nd half') || s.includes('second half')) return 'session-2half';
  if (s.includes('full') || s.includes('term')) return 'session-full';
  return 'session-other';
}

function sessionLabel(session) {
  const s = (session || '').toLowerCase();
  if (s.includes('1st half') || s.includes('first half')) return '1st half';
  if (s.includes('2nd half') || s.includes('second half')) return '2nd half';
  return null;
}

function shortCode(code) {
  const m = code.match(/^([A-Z]+)-[A-Z]+\.(\d+)/);
  return m ? `${m[1]} ${m[2]}` : code;
}

function fmtDateShort(dateStr) {
  if (!dateStr) return '';
  const [m, d] = dateStr.split('/');
  return `${parseInt(m)}/${parseInt(d)}`;
}

function parseISODate(dateStr) {
  if (!dateStr) return null;
  const [m, d, y] = dateStr.split('/');
  return new Date(+y, +m - 1, +d);
}

function renderSchedule() {
  // Filter planned courses to the selected semester
  const planned = allCourses.filter(c =>
    c.status === 'planned' && (c.semester || 'fall_2026') === currentSchedSem
  );
  renderSchedStats(planned);
  renderCalendar(planned);
  renderLegend(planned);
  renderPhases(planned);
}

function renderSchedStats(planned) {
  const container = document.getElementById('sched-stats');
  if (!planned.length) {
    container.innerHTML = '<div class="empty-schedule" style="grid-column:1/-1">Add courses to your plan to see your schedule.</div>';
    return;
  }

  const totalCredits = planned.reduce((s, c) => s + (c.credits || 0), 0);
  const fullCourses = planned.filter(c => !sessionLabel(c.session)).length;
  const halfCourses = planned.length - fullCourses;

  // Day load count
  const dayCount = {};
  for (const c of planned) {
    for (const m of (c.meetings || [])) {
      for (const d of (m.days || [])) {
        dayCount[d] = (dayCount[d] || 0) + 1;
      }
    }
  }
  const peakDay = Object.entries(dayCount).sort((a,b) => b[1]-a[1])[0]?.[0] ?? '—';
  const busyDays = new Set(Object.keys(dayCount));
  const freeDays = DAYS_ORDER.filter(d => !busyDays.has(d));
  let freeDayStr = freeDays.length === 0 ? 'none' :
    freeDays.length >= 3 ? freeDays[0] + '–' + freeDays[freeDays.length-1] :
    freeDays.join(', ');
  if (freeDays.includes('Fri') && !busyDays.has('Sat') && !busyDays.has('Sun')) {
    freeDayStr = freeDays[0] + '–Sun';
  }

  const credStr = totalCredits % 1 === 0 ? totalCredits : totalCredits.toFixed(1);
  const coursesSub = halfCourses > 0 ? `${fullCourses} full + ${halfCourses} half` : `${fullCourses} full term`;

  container.innerHTML = `
    <div class="sched-stat">
      <div class="sched-stat-label">Credits</div>
      <div class="sched-stat-value">${credStr}</div>
      <div class="sched-stat-sub">all validated</div>
    </div>
    <div class="sched-stat">
      <div class="sched-stat-label">Courses</div>
      <div class="sched-stat-value">${planned.length}</div>
      <div class="sched-stat-sub">${coursesSub}</div>
    </div>
    <div class="sched-stat">
      <div class="sched-stat-label">Peak day</div>
      <div class="sched-stat-value">${esc(peakDay)}</div>
      <div class="sched-stat-sub">${dayCount[peakDay] || 0} course${dayCount[peakDay] !== 1 ? 's' : ''}</div>
    </div>
    <div class="sched-stat">
      <div class="sched-stat-label">Free days</div>
      <div class="sched-stat-value" style="font-size:1.4rem">${esc(freeDayStr)}</div>
      <div class="sched-stat-sub">no classes</div>
    </div>
  `;
}

function renderCalendar(planned) {
  const container = document.getElementById('sched-calendar');
  container.innerHTML = '';

  if (!planned.length) return;

  // Find which days have courses
  const usedDays = new Set();
  for (const c of planned) {
    for (const m of (c.meetings || [])) {
      for (const d of (m.days || [])) usedDays.add(d);
    }
  }
  const days = DAYS_ORDER.filter(d => usedDays.has(d));
  if (!days.length) return;

  // Set grid columns: time axis + one per day
  container.style.gridTemplateColumns = `48px repeat(${days.length}, 1fr)`;

  const totalHours = CAL_END_H - CAL_START_H;

  // Time axis
  const axis = document.createElement('div');
  axis.className = 'cal-time-axis';
  axis.innerHTML = '<div class="cal-time-header"></div>' +
    Array.from({length: totalHours}, (_, i) => {
      const h = CAL_START_H + i;
      const label = h < 12 ? `${h}a` : h === 12 ? '12p' : `${h-12}p`;
      return `<div class="cal-time-cell">${label}</div>`;
    }).join('');
  container.appendChild(axis);

  // Day columns
  for (const day of days) {
    const col = document.createElement('div');
    col.className = 'cal-day-col';

    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header';
    hdr.textContent = day;
    col.appendChild(hdr);

    const body = document.createElement('div');
    body.className = 'cal-day-body';
    body.style.height = `${totalHours * PX_PER_H}px`;

    // Add course blocks for this day
    for (const course of planned) {
      for (const mtg of (course.meetings || [])) {
        if (!(mtg.days || []).includes(day)) continue;
        const startM = parseMins(mtg.start_time);
        const endM   = parseMins(mtg.end_time);
        if (startM === null || endM === null) continue;

        const top    = (startM - CAL_START_H * 60) * (PX_PER_H / 60);
        const height = Math.max((endM - startM) * (PX_PER_H / 60), 24);
        const badge  = sessionLabel(course.session);
        const tall   = height > 55;

        const block = document.createElement('div');
        block.className = `cal-block ${sessionClass(course.session)}`;
        block.style.cssText = `top:${top}px;height:${height}px;`;

        const startLabel = course.start_date ? parseISODate(course.start_date) : null;
        // Detect if course starts mid-semester (>2 weeks after Sep 1)
        const semStart = new Date(2026, 8, 1); // Sep 1 2026
        const isDelayed = startLabel && (startLabel - semStart) > 14 * 86400000;

        block.innerHTML = `
          <div class="cal-block-code">${esc(shortCode(course.code))}${course.credits ? ` · ${course.credits}cr` : ''}</div>
          <div class="cal-block-title">${esc(course.title || '')}</div>
          <div class="cal-block-time">${fmtTime(mtg.start_time)}–${fmtTime(mtg.end_time)}</div>
          ${tall && course.instructors?.length ? `<div class="cal-block-instructor">${esc(course.instructors[0])}</div>` : ''}
          ${isDelayed ? `<div class="cal-block-starts">starts ${fmtDateShort(course.start_date)}</div>` : ''}
          ${badge ? `<span class="cal-block-badge">${esc(badge)}</span>` : ''}
        `;
        body.appendChild(block);
      }
    }

    col.appendChild(body);
    container.appendChild(col);
  }
}

function renderLegend(planned) {
  const container = document.getElementById('sched-legend');
  const types = new Set(planned.map(c => sessionClass(c.session)));

  const defs = [
    { cls: 'session-full',  color: '#1a3a5c', label: 'Full term (Sep–Dec)' },
    { cls: 'session-1half', color: '#3d2d00', label: '1st half' },
    { cls: 'session-2half', color: '#143d1f', label: '2nd half' },
    { cls: 'session-other', color: '#2d1a3d', label: 'Other session' },
  ];

  // Annotate label with actual date range from planned courses
  for (const def of defs) {
    const courses = planned.filter(c => sessionClass(c.session) === def.cls);
    if (!courses.length) continue;
    const starts = courses.map(c => c.start_date).filter(Boolean).sort();
    const ends   = courses.map(c => c.end_date).filter(Boolean).sort().reverse();
    if (starts.length && ends.length && def.cls !== 'session-full') {
      def.label += ` (${fmtDateShort(starts[0])}–${fmtDateShort(ends[0])})`;
    }
  }

  container.innerHTML = defs
    .filter(d => types.has(d.cls))
    .map(d => `
      <div class="legend-item">
        <div class="legend-swatch" style="background:${d.color}"></div>
        <span>${esc(d.label)}</span>
      </div>
    `).join('');
}

function renderPhases(planned) {
  const container = document.getElementById('sched-phases');
  const note = document.getElementById('sched-phases-note');

  if (!planned.length) { container.innerHTML = ''; note.textContent = ''; return; }

  // Collect all unique boundary dates from planned courses
  const events = [];
  for (const c of planned) {
    if (c.start_date) events.push({ date: parseISODate(c.start_date), type: 'start', course: c });
    if (c.end_date)   events.push({ date: parseISODate(c.end_date),   type: 'end',   course: c });
  }
  events.sort((a, b) => a.date - b.date);

  // Build phases: each boundary is a new phase
  const boundaries = [...new Set(events.map(e => e.date.getTime()))].sort((a,b)=>a-b);
  const semEnd = new Date(Math.max(...planned.map(c => parseISODate(c.end_date) || 0)));

  const fmtPhaseDate = d => `${d.getMonth()+1}/${d.getDate()}`;

  const fullTermCourses = planned.filter(c => sessionClass(c.session) === 'session-full');
  const halfCourses     = planned.filter(c => sessionClass(c.session) !== 'session-full');

  const phases = [];

  if (boundaries.length === 0) return;

  // Phase 1: semester start → first half-course start
  const semStartDate = new Date(Math.min(...planned.map(c => parseISODate(c.start_date) || Infinity)));
  const firstHalfStart = halfCourses.length
    ? new Date(Math.min(...halfCourses.map(c => parseISODate(c.start_date) || Infinity)))
    : null;

  if (firstHalfStart && firstHalfStart > semStartDate) {
    const dayBefore = new Date(firstHalfStart); dayBefore.setDate(dayBefore.getDate() - 1);
    phases.push({
      start: semStartDate, end: dayBefore,
      label: fullTermCourses.map(c => shortCode(c.code)).join(', ') || 'Base load'
    });
  }

  // Middle phases: each half-course window
  const halfGroups = {};
  for (const c of halfCourses) {
    const key = `${c.start_date}|${c.end_date}`;
    if (!halfGroups[key]) halfGroups[key] = { start: parseISODate(c.start_date), end: parseISODate(c.end_date), courses: [] };
    halfGroups[key].courses.push(c);
  }

  const sortedGroups = Object.values(halfGroups).sort((a,b) => a.start - b.start);
  let lastEnd = firstHalfStart ? new Date(firstHalfStart.getTime() - 86400000) : semStartDate;

  for (const g of sortedGroups) {
    // Gap phase
    const gapStart = new Date(lastEnd); gapStart.setDate(gapStart.getDate() + 1);
    if (gapStart < g.start) {
      const gapEnd = new Date(g.start); gapEnd.setDate(gapEnd.getDate() - 1);
      phases.push({ start: gapStart, end: gapEnd, label: 'Full term only' });
    }
    // This group
    phases.push({
      start: g.start, end: g.end,
      label: '+ ' + g.courses.map(c => `${shortCode(c.code)} ${
        (c.meetings?.[0]?.days || []).join('/')
      } ${fmtTime(c.meetings?.[0]?.start_time ?? '')}`).join(', ')
    });
    lastEnd = g.end;
  }

  // Final phase: after last half-course ends
  const afterLastHalf = new Date(lastEnd); afterLastHalf.setDate(afterLastHalf.getDate() + 1);
  if (afterLastHalf < semEnd) {
    phases.push({ start: afterLastHalf, end: semEnd, label: 'Full term only' });
  }

  // If no half courses at all, just show one phase
  if (!halfCourses.length) {
    phases.push({ start: semStartDate, end: semEnd, label: 'Full term · no half-courses' });
  }

  container.innerHTML = phases.map(ph => `
    <div class="phase-seg">
      <div class="phase-dates">${fmtPhaseDate(ph.start)}–${fmtPhaseDate(ph.end)}</div>
      <div class="phase-label">${esc(ph.label)}</div>
    </div>
  `).join('');

  const fullNames = fullTermCourses.map(c => shortCode(c.code)).join(', ');
  note.textContent = fullNames
    ? `Base load (${fullTermCourses.reduce((s,c)=>s+(c.credits||0),0)} credits, full-term courses${fullNames ? ': ' + fullNames : ''}) runs the whole semester. Half-term courses bolt on during their windows — never simultaneously.`
    : '';
}


// ── Go ────────────────────────────────────────────────────────────────────────

init();
