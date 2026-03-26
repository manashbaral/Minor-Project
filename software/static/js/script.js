// ============================================================
//  AMRDS — script.js  (v5)
//  New: protocol editing, volume number input, dispense notes,
//  analytics date filter, avg duration, e-stop overlay fix,
//  refresh protection (beforeunload + lock badge + auto-resume)
// ============================================================

// ── Globals ──────────────────────────────────────────────────
let dispensing         = false;
let progressInterval   = null;
let elapsedTimer       = null;
let currentHistoryPage = 0;
const historyPerPage   = 5;
let currentUserRole    = null;
let _renameModalInst   = null;
let reagentNames       = { A: 'Reagent A', B: 'Reagent B' };
let dispenseStartTime  = null;
let analyticsChartInst = null;
let _analyticsRawData  = null;   // cached for date filter

// Multi-step protocol state
let activeProtocolSteps  = null;
let currentProtocolName  = null;
let _editingProtocolId   = null;  // null = create, number = edit

// ── Tiny helpers ─────────────────────────────────────────────
function _set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
function stopProgressPoll() {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}
function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

// ── Refresh protection ────────────────────────────────────────
function _setRefreshLock(active) {
    const badge = document.getElementById('dispenseLockBadge');
    if (badge) badge.style.display = active ? 'flex' : 'none';
    if (active) {
        window.onbeforeunload = (e) => {
            e.preventDefault();
            e.returnValue = 'A dispense is in progress. Leaving now will interrupt it. Are you sure?';
            return e.returnValue;
        };
    } else {
        window.onbeforeunload = null;
    }
}

// ── Auth ──────────────────────────────────────────────────────
function doLogout() {
    if (!confirm('Sign out of the system?')) return;
    fetch('/logout', { method: 'POST' })
        .then(() => window.location.href = '/login')
        .catch(() => window.location.href = '/login');
}
function showSessionExpired() {
    const el = document.getElementById('sessionExpiredOverlay');
    if (el) el.style.display = 'flex';
}
const _origFetch = window.fetch;
window.fetch = function(...args) {
    return _origFetch(...args).then(res => {
        if (res.status === 401) showSessionExpired();
        return res;
    });
};

// ── Role UI ───────────────────────────────────────────────────
function applyRoleUI(role) {
    currentUserRole = role;
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = role === 'admin' ? '' : 'none';
    });
}

// ── Theme ─────────────────────────────────────────────────────
function toggleDarkMode() {
    const html   = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    _updateThemeIcon(!isDark);
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
}
function _updateThemeIcon(isDark) {
    const el = document.getElementById('darkModeIcon');
    if (!el) return;
    el.innerHTML = isDark
        ? '<use href="#icon-sun"/>'
        : '<use href="#icon-moon"/>';
}
function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    _updateThemeIcon(saved === 'dark');
}

// ── Log Drawer ────────────────────────────────────────────────
function openLogDrawer() {
    document.getElementById('logDrawer').classList.add('open');
    document.getElementById('drawerOverlay').classList.add('open');
    const sub = document.getElementById('drawerSub');
    if (sub) sub.textContent = currentUserRole === 'admin' ? 'All operator records' : 'Your records only';
    updateHistory(0);
}
function closeLogDrawer() {
    document.getElementById('logDrawer').classList.remove('open');
    document.getElementById('drawerOverlay').classList.remove('open');
}

// ── Reagent Rename ────────────────────────────────────────────
let renamingReagent = null;
function openRenameModal(reagent) {
    renamingReagent = reagent;
    _set('renameModalTitle', `Rename Reagent ${reagent}`);
    document.getElementById('renameInput').value = reagentNames[reagent];
    const errEl = document.getElementById('renameErrorMsg');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    _renameModalInst = new bootstrap.Modal(document.getElementById('renameModal'));
    _renameModalInst.show();
}
function applyRename() {
    const val = document.getElementById('renameInput').value.trim();
    if (!val) return;
    const oldName = reagentNames[renamingReagent];
    const isA     = renamingReagent === 'A';
    const ids     = isA
        ? ['labelReagentA','summaryLabelA','summaryLabelA2','ovNameA','ovCompleteNameA','ovHaltedNameA']
        : ['labelReagentB','summaryLabelB','summaryLabelB2','ovNameB','ovCompleteNameB','ovHaltedNameB'];
    reagentNames[renamingReagent] = val;
    ids.forEach(id => _set(id, val));
    updateSummary();
    const btn = document.getElementById('renameApplyBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    fetch('/settings/reagent-names', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: reagentNames.A, b: reagentNames.B })
    })
    .then(async r => {
        const data = await r.json();
        if (!r.ok || data.status !== 'success') throw new Error(data.message || 'Save failed');
        if (_renameModalInst) { _renameModalInst.hide(); _renameModalInst = null; }
        showStatus(`Reagent ${renamingReagent} renamed to "${val}" and saved.`, 'success');
        loadProtocols();
    })
    .catch(err => {
        reagentNames[renamingReagent] = oldName;
        ids.forEach(id => _set(id, oldName));
        updateSummary();
        const msgEl = document.getElementById('renameErrorMsg');
        if (msgEl) { msgEl.textContent = `Could not save: ${err.message}`; msgEl.style.display = 'block'; }
    })
    .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
    });
}
function applyReagentNames(nameA, nameB) {
    if (nameA && nameA.trim()) {
        reagentNames.A = nameA.trim();
        ['labelReagentA','summaryLabelA','summaryLabelA2','ovNameA','ovCompleteNameA','ovHaltedNameA']
            .forEach(id => _set(id, reagentNames.A));
    }
    if (nameB && nameB.trim()) {
        reagentNames.B = nameB.trim();
        ['labelReagentB','summaryLabelB','summaryLabelB2','ovNameB','ovCompleteNameB','ovHaltedNameB']
            .forEach(id => _set(id, reagentNames.B));
    }
}

// ── Summary ───────────────────────────────────────────────────
function updateSummary() {
    const a = Number(document.getElementById('waterSlider').value);
    const b = Number(document.getElementById('syrupSlider').value);
    _set('summaryVolA',  `${a} ml`);
    _set('summaryVolB',  `${b} ml`);
    _set('summaryTotal', `${a + b} ml`);
    let ratio = '— : —';
    if (a > 0 && b > 0) {
        const gcd = (x, y) => y === 0 ? x : gcd(y, x % y);
        ratio = `${a / gcd(a,b)} : ${b / gcd(a,b)}`;
    } else if (a > 0) ratio = 'A only';
    else if (b > 0)   ratio = 'B only';
    _set('summaryRatio', ratio);
    const total = a + b;
    const segA = document.getElementById('ratioSegA');
    const segB = document.getElementById('ratioSegB');
    if (segA) segA.style.width = (total > 0 ? (a/total*100).toFixed(1) : 0) + '%';
    if (segB) segB.style.width = (total > 0 ? (b/total*100).toFixed(1) : 0) + '%';
}

// ── Sliders + Number inputs (bidirectional sync) ──────────────
function bindSlider(sliderId, numberId) {
    const slider = document.getElementById(sliderId);
    const numInp = document.getElementById(numberId);
    if (!slider || !numInp) return;

    slider.addEventListener('input', () => {
        numInp.value = slider.value;
        updateSummary();
    });
    numInp.addEventListener('input', () => {
        let v = parseInt(numInp.value, 10);
        if (isNaN(v) || v < 0)   v = 0;
        if (v > 1000)            v = 1000;
        numInp.value  = v;
        slider.value  = v;
        updateSummary();
    });
    numInp.addEventListener('blur', () => {
        if (numInp.value === '') { numInp.value = 0; slider.value = 0; updateSummary(); }
    });
}

// ── Progress bar ──────────────────────────────────────────────
function setProgressPct(pct) {
    const bar = document.getElementById('progressBar');
    const lbl = document.getElementById('progressPct');
    const c   = document.getElementById('progressContainer');
    if (bar) bar.style.width   = pct + '%';
    if (lbl) lbl.textContent   = Math.round(pct) + '%';
    if (c)   c.style.display   = dispensing ? '' : 'none';
}
function resetProgressBar() {
    const bar = document.getElementById('progressBar');
    const lbl = document.getElementById('progressPct');
    const c   = document.getElementById('progressContainer');
    if (bar) bar.style.width = '0%';
    if (lbl) lbl.textContent = '0%';
    if (c)   c.style.display = 'none';
}

// ── Confirmation modal ────────────────────────────────────────
function showConfirmModal(reagentA, reagentB, sequence, onConfirm) {
    _set('confirmLabelA', reagentNames.A);
    _set('confirmLabelB', reagentNames.B);
    _set('confirmVolA',   reagentA > 0 ? `${reagentA} ml` : 'SKIP');
    _set('confirmVolB',   reagentB > 0 ? `${reagentB} ml` : 'SKIP');
    _set('confirmTotal',  `${reagentA + reagentB} ml`);
    let ratio = '—';
    if (reagentA > 0 && reagentB > 0) {
        const gcd = (x,y) => y===0?x:gcd(y,x%y);
        const g = gcd(reagentA, reagentB);
        ratio = `${reagentA/g} : ${reagentB/g}`;
    } else ratio = reagentA > 0 ? 'A only' : 'B only';
    _set('confirmRatio',    ratio);
    _set('confirmSequence', sequence || (reagentA > 0 && reagentB > 0
        ? 'Pump 1 then Pump 2' : reagentA > 0 ? 'Pump 1 only' : 'Pump 2 only'));
    // Clear note field
    const noteEl = document.getElementById('dispenseNoteInput');
    if (noteEl) noteEl.value = '';
    const modal = new bootstrap.Modal(document.getElementById('confirmModal'));
    modal.show();
    const btn = document.getElementById('confirmDispenseBtn');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => { modal.hide(); onConfirm(); });
}

// ── Protocols ─────────────────────────────────────────────────
function loadProtocols() {
    fetch('/protocols')
        .then(r => r.json())
        .then(protocols => {
            const body = document.getElementById('protocolsBody');
            if (!protocols.length) {
                body.innerHTML = '<div class="protocol-empty">No protocols saved. Click <strong>+ New</strong> to create one.</div>';
                return;
            }
            body.innerHTML = '';
            protocols.forEach(p => {
                const steps  = p.steps || [];
                const totalA = steps.reduce((a,s) => a + (s.vol_a || (s.pump===1 ? s.volume_ml : 0) || 0), 0);
                const totalB = steps.reduce((a,s) => a + (s.vol_b || (s.pump===2 ? s.volume_ml : 0) || 0), 0);
                const hint   = [totalA>0?`${totalA} ml ${reagentNames.A}`:'', totalB>0?`${totalB} ml ${reagentNames.B}`:''].filter(Boolean).join(' + ');
                const stepsHint  = steps.length + (steps.length===1?' step':' steps');
                const globalBadge = p.is_global ? '<span class="protocol-global-badge">global</span>' : '';
                const currentUser = document.getElementById('operatorName')?.textContent?.trim();
                const canEdit    = currentUserRole==='admin' || p.created_by===currentUser;
                const editBtn    = canEdit
                    ? `<button class="protocol-action-btn protocol-edit-btn" onclick="openEditProtocol(${p.id})" title="Edit">
                           <svg width="13" height="13"><use href="#icon-edit"/></svg>
                       </button>` : '';
                const delBtn     = canEdit
                    ? `<button class="protocol-action-btn protocol-del-btn" onclick="deleteProtocol(${p.id})" title="Delete">
                           <svg width="13" height="13"><use href="#icon-x"/></svg>
                       </button>` : '';
                const card = document.createElement('div');
                card.className = 'protocol-card';
                card.innerHTML = `
                    <div class="protocol-card-main" onclick="runProtocol(${JSON.stringify(steps).replace(/"/g,'&quot;')}, '${p.name.replace(/'/g,"\\'")}')">
                        <div class="protocol-name">${p.name}${globalBadge}</div>
                        <div class="protocol-hint">${hint} &middot; ${stepsHint}</div>
                    </div>
                    <div class="protocol-actions">${editBtn}${delBtn}</div>`;
                body.appendChild(card);
            });
        })
        .catch(() => {
            const body = document.getElementById('protocolsBody');
            if (body) body.innerHTML = '<div class="protocol-empty">Failed to load protocols.</div>';
        });
}

function runProtocol(steps, name) {
    if (dispensing) { showStatus('Cannot change protocol while dispensing.', 'danger'); return; }
    if (!Array.isArray(steps)) {
        try { steps = JSON.parse(steps); } catch(_) { return; }
    }
    steps = steps.map(s => s.vol_a !== undefined ? s : {
        label: `Pump ${s.pump}`,
        vol_a: s.pump===1 ? (s.volume_ml||0) : 0,
        vol_b: s.pump===2 ? (s.volume_ml||0) : 0,
        delay_after_s: s.delay_after_s || 0
    });
    activeProtocolSteps = steps;
    currentProtocolName = name || null;
    const totalA = steps.reduce((a,s)=>a+(s.vol_a||0),0);
    const totalB = steps.reduce((a,s)=>a+(s.vol_b||0),0);
    const clampA = Math.min(totalA, 1000);
    const clampB = Math.min(totalB, 1000);
    document.getElementById('waterSlider').value      = clampA;
    document.getElementById('syrupSlider').value      = clampB;
    document.getElementById('waterNumberInput').value = clampA;
    document.getElementById('syrupNumberInput').value = clampB;
    updateSummary();
}

// ── Protocol builder — open for create ───────────────────────
let protocolStepCount = 0;
let dragSrc = null;

function openProtocolBuilderModal() {
    _editingProtocolId = null;
    _set('protocolBuilderTitle', 'New Protocol');
    document.getElementById('protocolName').value = '';
    document.getElementById('protocolStepsContainer').innerHTML = '';
    const msgEl = document.getElementById('protocolBuilderMsg');
    if (msgEl) { msgEl.textContent = ''; msgEl.style.color = 'var(--text-3)'; }
    protocolStepCount = 0;
    addProtocolStep();
    if (currentUserRole === 'admin') {
        const wrap = document.getElementById('globalProtocolWrap');
        if (wrap) wrap.style.display = '';
        const chk = document.getElementById('protocolIsGlobal');
        if (chk) chk.checked = false;
    }
    const saveBtn = document.getElementById('protocolSaveBtn');
    if (saveBtn) saveBtn.textContent = 'Save Protocol';
    new bootstrap.Modal(document.getElementById('protocolBuilderModal')).show();
}

// ── Protocol builder — open for EDIT (NEW) ───────────────────
function openEditProtocol(pid) {
    fetch('/protocols')
        .then(r => r.json())
        .then(protocols => {
            const p = protocols.find(x => x.id === pid);
            if (!p) { showStatus('Protocol not found.', 'danger'); return; }
            _editingProtocolId = pid;
            _set('protocolBuilderTitle', 'Edit Protocol');
            document.getElementById('protocolName').value = p.name;
            document.getElementById('protocolStepsContainer').innerHTML = '';
            protocolStepCount = 0;
            const msgEl = document.getElementById('protocolBuilderMsg');
            if (msgEl) { msgEl.textContent = ''; msgEl.style.color = 'var(--text-3)'; }
            // Populate existing steps
            const steps = (p.steps || []).map(s => s.vol_a !== undefined ? s : {
                label: `Pump ${s.pump}`,
                vol_a: s.pump===1 ? (s.volume_ml||0) : 0,
                vol_b: s.pump===2 ? (s.volume_ml||0) : 0,
                delay_after_s: s.delay_after_s || 0
            });
            steps.forEach(s => addProtocolStep(s));
            if (currentUserRole === 'admin') {
                const wrap = document.getElementById('globalProtocolWrap');
                if (wrap) wrap.style.display = '';
                const chk = document.getElementById('protocolIsGlobal');
                if (chk) chk.checked = !!p.is_global;
            }
            const saveBtn = document.getElementById('protocolSaveBtn');
            if (saveBtn) saveBtn.textContent = 'Update Protocol';
            new bootstrap.Modal(document.getElementById('protocolBuilderModal')).show();
        });
}

function addProtocolStep(prefill) {
    protocolStepCount++;
    const idx  = protocolStepCount;
    const wrap = document.getElementById('protocolStepsContainer');
    const card = document.createElement('div');
    card.className   = 'pstep-card';
    card.id          = `psc-${idx}`;
    card.draggable   = true;
    card.innerHTML   = `
        <div class="pstep-drag-handle" title="Drag to reorder">&#8942;</div>
        <div class="pstep-body">
            <div class="pstep-row pstep-label-row">
                <label class="pstep-field-label">Step label / note</label>
                <input type="text" class="dash-input pstep-label-input" id="sp-label-${idx}"
                       maxlength="40" placeholder="e.g. Buffer Mix, Rinse…"
                       value="${prefill?.label||''}">
            </div>
            <div class="pstep-row pstep-vols-row">
                <div class="pstep-vol-group">
                    <label class="pstep-field-label">${reagentNames.A} (ml)</label>
                    <input type="number" class="dash-input pstep-vol" id="sp-vola-${idx}"
                           min="0" max="1000" value="${prefill?.vol_a ?? 100}" placeholder="0 = skip">
                </div>
                <div class="pstep-vol-group">
                    <label class="pstep-field-label">${reagentNames.B} (ml)</label>
                    <input type="number" class="dash-input pstep-vol" id="sp-volb-${idx}"
                           min="0" max="1000" value="${prefill?.vol_b ?? 0}" placeholder="0 = skip">
                </div>
                <div class="pstep-vol-group">
                    <label class="pstep-field-label">Delay after (s)</label>
                    <input type="number" class="dash-input pstep-vol" id="sp-delay-${idx}"
                           min="0" max="300" value="${prefill?.delay_after_s ?? 2}" placeholder="s">
                </div>
            </div>
        </div>
        <button class="pstep-remove-btn" onclick="removeProtocolStep(${idx})" title="Remove step">
            <svg width="11" height="11"><use href="#icon-x"/></svg>
        </button>
        <span class="pstep-num" id="spnum-${idx}">1</span>`;

    card.addEventListener('dragstart', e => {
        dragSrc = card; card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.pstep-card').forEach(c => c.classList.remove('drag-over'));
        dragSrc = null; renumberSteps();
    });
    card.addEventListener('dragover', e => {
        e.preventDefault();
        if (dragSrc && dragSrc !== card) {
            document.querySelectorAll('.pstep-card').forEach(c => c.classList.remove('drag-over'));
            card.classList.add('drag-over');
        }
    });
    card.addEventListener('drop', e => {
        e.preventDefault();
        if (dragSrc && dragSrc !== card) {
            const cards  = [...document.getElementById('protocolStepsContainer').querySelectorAll('.pstep-card')];
            const srcIdx = cards.indexOf(dragSrc);
            const tgtIdx = cards.indexOf(card);
            const wrap2  = document.getElementById('protocolStepsContainer');
            if (srcIdx < tgtIdx) wrap2.insertBefore(dragSrc, card.nextSibling);
            else                  wrap2.insertBefore(dragSrc, card);
        }
        card.classList.remove('drag-over');
    });
    wrap.appendChild(card);
    renumberSteps();
}

function removeProtocolStep(idx) {
    const el = document.getElementById(`psc-${idx}`);
    if (el) { el.remove(); renumberSteps(); }
}
function renumberSteps() {
    document.querySelectorAll('#protocolStepsContainer .pstep-card').forEach((c,i) => {
        const badge = c.querySelector('.pstep-num');
        if (badge) badge.textContent = i+1;
    });
}

function saveProtocol() {
    const name  = document.getElementById('protocolName').value.trim();
    const msgEl = document.getElementById('protocolBuilderMsg');
    if (!name) { msgEl.textContent = 'Protocol name is required.'; msgEl.style.color='var(--danger)'; return; }
    const cards = document.querySelectorAll('#protocolStepsContainer .pstep-card');
    const steps = []; let valid = true;
    cards.forEach(card => {
        const idx   = card.id.replace('psc-','');
        const label = document.getElementById(`sp-label-${idx}`)?.value.trim() || '';
        const volA  = parseFloat(document.getElementById(`sp-vola-${idx}`)?.value) || 0;
        const volB  = parseFloat(document.getElementById(`sp-volb-${idx}`)?.value) || 0;
        const delay = parseFloat(document.getElementById(`sp-delay-${idx}`)?.value) || 0;
        if (volA < 0 || volB < 0) { valid = false; return; }
        if (volA === 0 && volB === 0) { valid = false; return; }
        steps.push({ label, vol_a: volA, vol_b: volB, delay_after_s: delay });
    });
    if (!steps.length) { msgEl.textContent='Add at least one step.'; msgEl.style.color='var(--danger)'; return; }
    if (!valid) { msgEl.textContent='Each step needs at least one non-zero volume.'; msgEl.style.color='var(--danger)'; return; }
    const isGlobal = document.getElementById('protocolIsGlobal')?.checked || false;
    msgEl.textContent = 'Saving…'; msgEl.style.color = 'var(--text-3)';

    // PUT for edit, POST for create
    const url    = _editingProtocolId ? `/protocols/${_editingProtocolId}` : '/protocols';
    const method = _editingProtocolId ? 'PUT' : 'POST';

    fetch(url, {
        method, headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name, steps, is_global: isGlobal })
    })
    .then(r => r.json())
    .then(d => {
        if (d.status !== 'success') throw new Error(d.message);
        bootstrap.Modal.getInstance(document.getElementById('protocolBuilderModal'))?.hide();
        loadProtocols();
        showStatus(`Protocol "${name}" ${_editingProtocolId ? 'updated' : 'saved'}.`, 'success');
        _editingProtocolId = null;
    })
    .catch(err => { msgEl.textContent = err.message; msgEl.style.color = 'var(--danger)'; });
}

function deleteProtocol(id) {
    if (!confirm('Delete this protocol?')) return;
    fetch(`/protocols/${id}`, { method:'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (d.status==='success') { loadProtocols(); showStatus('Protocol deleted.','info'); }
            else showStatus(d.message,'danger');
        });
}

// ── Dispense ──────────────────────────────────────────────────
async function startDispensing() {
    const dot = document.getElementById('statusDot');
    if (!dot || !dot.classList.contains('connected')) {
        showStatus('Cannot initiate: Controller is disconnected.', 'danger'); return;
    }
    if (dispensing) return;
    let steps;
    if (activeProtocolSteps && activeProtocolSteps.length > 0) {
        steps = activeProtocolSteps;
    } else {
        const reagentA = Number(document.getElementById('waterSlider').value);
        const reagentB = Number(document.getElementById('syrupSlider').value);
        if (reagentA === 0 && reagentB === 0) {
            showStatus('[ALERT] Both reagent volumes are zero.', 'danger'); return;
        }
        steps = [{ label: 'Manual dispense', vol_a: reagentA, vol_b: reagentB, delay_after_s: 0 }];
        currentProtocolName = null;
    }
    const totalA   = steps.reduce((a,s)=>a+(s.vol_a||0), 0);
    const totalB   = steps.reduce((a,s)=>a+(s.vol_b||0), 0);
    const seqLabel = steps.map((s,i) => {
        const parts = [];
        if (s.vol_a>0) parts.push(`${reagentNames.A} ${s.vol_a} ml`);
        if (s.vol_b>0) parts.push(`${reagentNames.B} ${s.vol_b} ml`);
        return `Step ${i+1}${s.label?` "${s.label}"`:''}: ${parts.join(' + ')}`;
    }).join(' → ');
    const confirmFn = async () => {
        try {
            const r = await _origFetch('/esp32/status');
            const d = await r.json();
            if (d.status !== 'connected') {
                showStatus('Controller went offline. Dispense aborted.', 'danger'); return;
            }
        } catch {
            showStatus('Cannot verify controller status. Dispense aborted.', 'danger'); return;
        }
        // Capture note from confirm modal
        const noteVal = document.getElementById('dispenseNoteInput')?.value?.trim() || '';
        executeMultiStep(steps, noteVal);
    };
    showConfirmModal(totalA, totalB, seqLabel, confirmFn);
}

async function executeMultiStep(steps, noteText) {
    dispensing = true;
    _setRefreshLock(true);
    const btn = document.getElementById('dispenseBtn');
    if (btn) btn.disabled = true;
    _set('dispenseBtnText', 'Dispensing…');
    const totalA = steps.reduce((a,s)=>a+(s.vol_a||0), 0);
    const totalB = steps.reduce((a,s)=>a+(s.vol_b||0), 0);
    initMonitorUI(totalA, totalB);
    startElapsedTimer();
    overlayStartDispensing(steps);
    try {
        for (let i = 0; i < steps.length; i++) {
            if (!dispensing) break;
            const step      = steps[i];
            const stepLabel = step.label || `Step ${i+1}`;
            overlaySetStep(i+1, steps.length, stepLabel,
                [step.vol_a>0?(reagentNames.A+' '+step.vol_a+'ml'):'',
                 step.vol_b>0?(reagentNames.B+' '+step.vol_b+'ml'):''].filter(Boolean).join(' then '));
            if (step.vol_a > 0) {
                if (!dispensing) break;
                await runPumpStage(1, reagentNames.A, step.vol_a,
                    { reagent_a: step.vol_a, reagent_b: 0, note: noteText });
            }
            if (step.vol_b > 0 && dispensing) {
                if (step.vol_a > 0) {
                    showStatus(`[STEP ${i+1}]  ${reagentNames.A} done. Starting ${reagentNames.B} in 1s…`, 'info');
                    resetProgressBar();
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!dispensing) break;
                await runPumpStage(2, reagentNames.B, step.vol_b,
                    { reagent_a: 0, reagent_b: step.vol_b, note: noteText });
            }
            if (!dispensing) break;
            if (step.delay_after_s > 0 && i < steps.length - 1) {
                showStatus(`[PAUSE]  Step ${i+1} complete. Next step in ${step.delay_after_s}s…`, 'info');
                resetProgressBar();
                await new Promise(r => setTimeout(r, step.delay_after_s * 1000));
            }
        }
        if (dispensing) await finishDispense(totalA, totalB);
    } catch (err) {
        if (err.message === 'Emergency stop detected') return;
        console.error('[executeMultiStep]', err);
        _set('ovStatusMsg', `Error: ${err.message}`);
        setTimeout(() => {
            _ovSetState('halted');
            _set('ovHaltedNameA', reagentNames.A);
            _set('ovHaltedNameB', reagentNames.B);
            _set('ovHaltedVolA',  '0.0 mL');
            _set('ovHaltedVolB',  '0.0 mL');
            _set('ovHaltedTotal', '0.0 mL');
            _set('ovHaltedStep',  `Error: ${err.message}`);
            _showHaltedReason(`System error: ${err.message}`);
        }, 2000);
        resetDispenseUI(true);
    }
}

// ── Dispensing Overlay ────────────────────────────────────────
let _overlayElapsedTimer = null;
let _overlayStartTime    = null;
let _overlayCurrentStep  = 0;
let _overlayTotalSteps   = 1;
let _overlayDispensedA   = 0;
let _overlayDispensedB   = 0;

function showDispenseOverlay() {
    const el = document.getElementById('dispenseOverlay');
    if (el) el.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}
function hideDispenseOverlay() {
    const el = document.getElementById('dispenseOverlay');
    if (el) el.style.display = 'none';
    document.body.style.overflow = '';
    if (_overlayElapsedTimer) { clearInterval(_overlayElapsedTimer); _overlayElapsedTimer = null; }
}
function overlayGoToDashboard() {
    hideDispenseOverlay();
    _setRefreshLock(false);
    dispensing = false;
    activeProtocolSteps = null;
    currentProtocolName = null;
    const btn = document.getElementById('dispenseBtn');
    if (btn) btn.disabled = false;
    _set('dispenseBtnText', 'Initiate Dispense');
    updateHistory();
    loadInventory(false);
}
function overlayViewHistory() {
    hideDispenseOverlay();
    openLogDrawer();
}

// Show structured halted reason box
function _showHaltedReason(msg) {
    const el = document.getElementById('ovHaltedReason');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
}

function overlayStartDispensing(steps) {
    _overlayStartTime   = Date.now();
    _overlayTotalSteps  = steps.length;
    _overlayCurrentStep = 0;
    _overlayDispensedA  = 0;
    _overlayDispensedB  = 0;
    _ovSetFlask('ovFlaskFillA', 0);
    _ovSetFlask('ovFlaskFillB', 0);
    _set('ovVolA','0.0 mL'); _set('ovVolB','0.0 mL');
    _set('ovTargetA','/ — mL'); _set('ovTargetB','/ — mL');
    const bA = document.getElementById('ovBadgeA'); if(bA){bA.className='ov-badge-wait';bA.textContent='Waiting';}
    const bB = document.getElementById('ovBadgeB'); if(bB){bB.className='ov-badge-wait';bB.textContent='Waiting';}
    const bar = document.getElementById('ovProgFill'); if(bar) bar.style.width='0%';
    _set('ovProgPct','0%'); _set('ovFlowA','— mL/s'); _set('ovFlowB','— mL/s');
    _set('ovStatusMsg', 'Initialising…');
    const reasonEl = document.getElementById('ovHaltedReason');
    if (reasonEl) { reasonEl.textContent = ''; reasonEl.style.display='none'; }
    _ovSetState('dispensing');
    showDispenseOverlay();
    if (_overlayElapsedTimer) clearInterval(_overlayElapsedTimer);
    _overlayElapsedTimer = setInterval(() => {
        if (!_overlayStartTime) return;
        const s   = Math.floor((Date.now()-_overlayStartTime)/1000);
        const fmt = String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
        _set('ovElapsed',  fmt);
        _set('ovElapsed2', fmt);
    }, 500);
}

function overlaySetStep(idx, total, label, noteText) {
    _overlayCurrentStep = idx;
    _set('ovStepBadge', 'Step '+idx+' of '+total);
    _set('ovStepLabel', label||('Step '+idx));
    _set('ovStepNote',  noteText||'');
    const b = document.getElementById('ovStepBadge');
    if (b) b.className = 'ov-step-badge';
}

function overlayUpdatePoll(pumpNum, dispensed, target, pct, statusText) {
    if (pumpNum===1) {
        _overlayDispensedA = dispensed;
        _ovSetFlask('ovFlaskFillA', target>0 ? dispensed/target : 0);
        _set('ovVolA', dispensed.toFixed(1)+' mL');
        _set('ovTargetA', '/ '+(target>0?target.toFixed(0):'—')+' mL');
        const bA=document.getElementById('ovBadgeA'); if(bA){bA.className='ov-badge-run';bA.textContent='Running';}
        const bB=document.getElementById('ovBadgeB'); if(bB){bB.className='ov-badge-wait';bB.textContent='Waiting';}
        const bar=document.getElementById('ovProgFill'); if(bar){bar.style.width=Math.min(pct,100).toFixed(1)+'%';bar.style.background='var(--reagent-a)';}
        _set('ovProgPct', Math.min(pct,100).toFixed(1)+'%');
        _set('ovProgLabel', reagentNames.A+' progress');
    } else {
        _overlayDispensedB = dispensed;
        _ovSetFlask('ovFlaskFillB', target>0 ? dispensed/target : 0);
        _set('ovVolB', dispensed.toFixed(1)+' mL');
        _set('ovTargetB', '/ '+(target>0?target.toFixed(0):'—')+' mL');
        const bB=document.getElementById('ovBadgeB'); if(bB){bB.className='ov-badge-run';bB.textContent='Running';}
        const bA=document.getElementById('ovBadgeA'); if(bA){bA.className='ov-badge-done';bA.textContent='Done';}
        const bar=document.getElementById('ovProgFill'); if(bar){bar.style.width=Math.min(pct,100).toFixed(1)+'%';bar.style.background='var(--reagent-b)';}
        _set('ovProgPct', Math.min(pct,100).toFixed(1)+'%');
        _set('ovProgLabel', reagentNames.B+' progress');
    }
    if (statusText !== null && statusText !== undefined) _set('ovStatusMsg', statusText);
}

function overlayShowComplete(totalA, totalB, protocolName) {
    if (_overlayElapsedTimer) { clearInterval(_overlayElapsedTimer); _overlayElapsedTimer = null; }
    _setRefreshLock(false);
    _ovSetFlask('ovFlaskFillA', totalA>0?1:0);
    _ovSetFlask('ovFlaskFillB', totalB>0?1:0);
    _set('ovCompleteNameA', reagentNames.A);
    _set('ovCompleteNameB', reagentNames.B);
    _set('ovCompleteVolA',  totalA.toFixed(1)+' mL');
    _set('ovCompleteVolB',  totalB.toFixed(1)+' mL');
    _set('ovCompleteTotal', (totalA+totalB).toFixed(1)+' mL');
    _set('ovCompleteProto', protocolName||'Manual dispense');
    if (_overlayStartTime) {
        const s=Math.floor((Date.now()-_overlayStartTime)/1000);
        _set('ovCompleteElapsed', String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'));
    }
    const b=document.getElementById('ovStepBadge'); if(b){b.className='ov-step-badge-done';b.textContent='Complete';}
    _ovSetState('complete');
}

// ── Emergency stop halted overlay — FIXED ────────────────────
// Now properly transitions from 'dispensing' state to 'halted' state
// and shows a clear reason message with proper formatting.
function overlayShowHalted(dispensedA, dispensedB, reason) {
    if (_overlayElapsedTimer) { clearInterval(_overlayElapsedTimer); _overlayElapsedTimer = null; }
    _setRefreshLock(false);
    _set('ovHaltedNameA',  reagentNames.A);
    _set('ovHaltedNameB',  reagentNames.B);
    _set('ovHaltedVolA',   dispensedA.toFixed(1)+' mL');
    _set('ovHaltedVolB',   dispensedB.toFixed(1)+' mL');
    _set('ovHaltedTotal',  (dispensedA+dispensedB).toFixed(1)+' mL');
    _set('ovHaltedStep',   'Halted at step '+_overlayCurrentStep+' of '+_overlayTotalSteps);
    // Show reason message
    const reasonMsg = reason
        || (dispensedA + dispensedB < 0.5 ? 'Emergency stop activated before dispensing began.' : 'Emergency stop activated. Pumps halted immediately.');
    _showHaltedReason(reasonMsg);
    const b=document.getElementById('ovStepBadge'); if(b){b.className='ov-step-badge-halt';b.textContent='Halted';}
    // Always force transition to halted state, even if currently showing dispensing
    _ovSetState('halted');
}

function _ovSetFlask(rectId, fraction) {
    const rect = document.getElementById(rectId);
    if (!rect) return;
    const f = Math.max(0, Math.min(1, isFinite(fraction)?fraction:0));
    const h = f*88;
    rect.setAttribute('y', String(138-h));
    rect.setAttribute('height', String(h+2));
}
function _ovSetState(state) {
    ['ovStateDispensing','ovStateComplete','ovStateHalted'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const show = state==='dispensing'?'ovStateDispensing':state==='complete'?'ovStateComplete':'ovStateHalted';
    const el = document.getElementById(show); if(el) el.style.display='';
    const nav = document.getElementById('ovNav');
    if (nav) {
        nav.style.background        = state==='halted'?'rgba(218,54,51,0.12)':'var(--surface-2)';
        nav.style.borderBottomColor = state==='halted'?'rgba(248,81,73,0.3)':'var(--border)';
    }
}

// ── Flask fill ────────────────────────────────────────────────
const FLASK_BOTTOM_Y = 138;
const FLASK_FILL_H   = 88;
function setFlaskFill(id, fraction) {
    const rect = document.getElementById(id);
    if (!rect) return;
    const f = Math.max(0, Math.min(1, isFinite(fraction) ? fraction : 0));
    const h = f * FLASK_FILL_H;
    rect.setAttribute('y',      String(FLASK_BOTTOM_Y - h));
    rect.setAttribute('height', String(h + 2));
}
function setDrip(id, active) {
    const el = document.getElementById(id);
    if (!el) return;
    if (active) { el.classList.remove('drip-hidden'); el.classList.add('drip-active'); el.setAttribute('opacity','0.9'); }
    else        { el.classList.add('drip-hidden');    el.classList.remove('drip-active'); el.setAttribute('opacity','0'); }
}
function setMonBadge(id, state) {
    const el  = document.getElementById(id);
    if (!el) return;
    const map = {idle:'badge-idle',dispensing:'badge-dispensing',completed:'badge-completed',halted:'badge-halted'};
    el.className   = 'mon-badge ' + (map[state] || 'badge-idle');
    el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}
function setPumpCardActive(num, active) {
    const card  = document.getElementById(`pumpCard${num}`);
    const state = document.getElementById(`pumpState${num}`);
    const badge = document.getElementById(`pumpBadge${num}`);
    if (!card) return;
    if (active) {
        card.classList.add('active');
        if (state) state.textContent = 'Running';
        if (badge) { badge.className = 'mon-badge badge-dispensing'; badge.textContent = 'Active'; }
    } else {
        card.classList.remove('active');
        if (state) state.textContent = 'Idle';
        if (badge) { badge.className = 'mon-badge badge-idle'; badge.textContent = 'Idle'; }
    }
}
function updateMonitorSegments(dA, tA, dB, tB) {
    const total = (tA||0)+(tB||0); if (total<=0) return;
    const fA = tA>0 ? Math.min((dA||0)/tA,1) : 1;
    const fB = tB>0 ? Math.min((dB||0)/tB,1) : 0;
    const sA = tA/total; const sB = tB/total;
    const elA = document.getElementById('monSegA');
    const elB = document.getElementById('monSegB');
    if (elA) { elA.style.width=(fA*sA*100).toFixed(2)+'%'; if (tB>0) elA.classList.add('has-b'); else elA.classList.remove('has-b'); }
    if (elB)   elB.style.width=(fB*sB*100).toFixed(2)+'%';
}

// ── Elapsed timer ─────────────────────────────────────────────
function startElapsedTimer() {
    stopElapsedTimer();
    dispenseStartTime = Date.now();
    elapsedTimer = setInterval(() => {
        if (!dispenseStartTime) return;
        _set('pillElapsed', ((Date.now()-dispenseStartTime)/1000).toFixed(1)+'s');
    }, 200);
}

// ── Progress poll ─────────────────────────────────────────────
function startProgressPoll(pumpNum, reagentLabel, volume) {
    stopProgressPoll();
    return new Promise((resolve, reject) => {
        let pollCount          = 0;
        let staleWarningActive = false;
        let pollActive         = true;
        const STALE_AFTER_POLLS = 20;
        const GRACE_POLLS       = 4;

        progressInterval = setInterval(async () => {
            if (!pollActive) { stopProgressPoll(); return; }
            try {
                const res  = await _origFetch('/progress');
                const prog = await res.json();
                pollCount++;

                const dispensed = pumpNum===1 ? (prog.dispensed_a||0) : (prog.dispensed_b||0);
                const target    = pumpNum===1 ? (prog.target_a   ||0) : (prog.target_b   ||0);
                const pct       = pumpNum===1 ? (prog.pct_a      ||0) : (prog.pct_b      ||0);

                if (!staleWarningActive && pollCount>=STALE_AFTER_POLLS && dispensed===0) {
                    staleWarningActive = true; showSensorWarning(STALE_AFTER_POLLS/2);
                }
                if (staleWarningActive && dispensed>0) {
                    staleWarningActive = false; hideSensorWarning();
                }

                const displayTarget = target>0 ? target : volume;
                const statusTxt = `[PUMP ${pumpNum}  ${reagentLabel}]  ${dispensed.toFixed(2)} / ${displayTarget.toFixed(1)} mL  (${pct.toFixed(1)}%)`;
                overlayUpdatePoll(pumpNum, dispensed, displayTarget, pct,
                    staleWarningActive ? null : statusTxt);
                if (!staleWarningActive) showStatus(statusTxt, 'warning');

                setProgressPct(Math.min(pct, 100));
                updateMonitorSegments(prog.dispensed_a||0, prog.target_a||0, prog.dispensed_b||0, prog.target_b||0);

                if (dispenseStartTime && dispensed>0) {
                    const elapsed = (Date.now()-dispenseStartTime)/1000;
                    const flowId  = pumpNum===1?'ovFlowA':'ovFlowB';
                    _set(flowId, (dispensed/elapsed).toFixed(2)+' mL/s');
                }

                const shouldCheckDone  = pollCount > GRACE_POLLS || prog.active;
                const relevantTarget   = pumpNum===1 ? (prog.target_a||0) : (prog.target_b||0);
                const pumpComplete     = relevantTarget > 0 && pct >= 100;

                if (shouldCheckDone && (!prog.active || pumpComplete)) {
                    pollActive = false;
                    stopProgressPoll();
                    clearSensorWarning();

                    // ── Physical / software e-stop detected ─────────────
                    if (prog.halted) {
                        dispensing = false;
                        activeProtocolSteps = null;
                        resetDispenseUI(true);
                        // Determine reason from progress context
                        const haltReason = 'Emergency stop was activated. Pumps halted immediately. Check system before continuing.';
                        overlayShowHalted(prog.dispensed_a||0, prog.dispensed_b||0, haltReason);
                        updateHistory();
                        loadInventory(false);
                        reject(new Error('Emergency stop detected'));
                        return;
                    }

                    setProgressPct(100);
                    showStatus(`[PUMP ${pumpNum} DONE]  ${reagentLabel}: ${displayTarget.toFixed(2)} mL dispensed`, 'success');
                    resolve({ dispensed: displayTarget, target: displayTarget });
                }
            } catch(e) { console.warn('[progress poll]', e.message); }
        }, 500);
    });
}

// ── Run single pump stage ─────────────────────────────────────
function runPumpStage(pumpNum, reagentLabel, volume, params) {
    return new Promise((resolve, reject) => {
        setPumpCardActive(pumpNum, true);
        setMonBadge(pumpNum===1?'monBadgeA':'monBadgeB', 'dispensing');
        _set(pumpNum===1?'monMsgA':'monMsgB', `Dispensing ${reagentLabel}…`);
        const c = document.getElementById('progressContainer');
        if (c) c.style.display = '';
        setProgressPct(0);
        fetch('/dispense', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(params)
        })
        .then(async res => {
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); }
            catch(_) {
                if (res.status===401||res.redirected) { showSessionExpired(); throw new Error('Session expired.'); }
                throw new Error('Unexpected server response.');
            }
            if (!res.ok) throw new Error(data.message||`Server error (${res.status})`);
            if (data.status!=='started') throw new Error(data.message||'Failed to start pump');
            return data;
        })
        .then(() => {
            showStatus(`[PUMP ${pumpNum} ACTIVE]  Dispensing ${reagentLabel}: ${volume} mL`, 'warning');
            startProgressPoll(pumpNum, reagentLabel, volume).then(resolve).catch(reject);
        })
        .catch(err => {
            setPumpCardActive(pumpNum, false);
            reject(err);
        });
    });
}

// ── Emergency stop ────────────────────────────────────────────
function emergencyStop() {
    dispensing = false;
    stopElapsedTimer();
    setPumpCardActive(1,false); setPumpCardActive(2,false);
    setMonBadge('monBadgeA','halted'); setMonBadge('monBadgeB','halted');
    clearSensorWarning();
    _set('ovStatusMsg', 'EMERGENCY STOP — Halting all pumps…');

    const pollWasRunning = progressInterval !== null;

    fetch('/emergency-stop', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ reason:'Operator triggered emergency stop via UI' })
    })
    .then(() => {
        if (!pollWasRunning) {
            stopProgressPoll();
            resetDispenseUI(true);
            overlayShowHalted(_overlayDispensedA, _overlayDispensedB,
                'Emergency stop triggered by operator. Pumps halted immediately.');
        }
        // If poll IS running it will detect prog.halted on next tick → overlayShowHalted called there
    })
    .catch(err => {
        console.warn('[emergencyStop]', err);
        stopProgressPoll();
        resetDispenseUI(true);
        overlayShowHalted(_overlayDispensedA, _overlayDispensedB,
            'Emergency stop triggered. Network error when notifying server — pumps may still be running. Verify hardware.');
    });
}

// ── Finish dispense ───────────────────────────────────────────
async function finishDispense(totalA, totalB) {
    stopElapsedTimer();
    showStatus(`[COMPLETE]  ${reagentNames.A}: ${totalA} mL  |  ${reagentNames.B}: ${totalB} mL`, 'success');
    overlayShowComplete(totalA, totalB, currentProtocolName);
    resetDispenseUI();
}
function resetDispenseUI(keepBar=false) {
    dispensing = false;
    activeProtocolSteps = null;
    _setRefreshLock(false);
    const btn = document.getElementById('dispenseBtn');
    if (btn) btn.disabled = false;
    _set('dispenseBtnText','Initiate Dispense');
    if (!keepBar) resetProgressBar();
}

// ── Monitor init ──────────────────────────────────────────────
function initMonitorUI(targetA, targetB) {
    setFlaskFill('flaskFillA',0); setFlaskFill('flaskFillB',0);
    setDrip('dripA',false); setDrip('dripB',false);
    setMonBadge('monBadgeA', targetA>0?'dispensing':'idle');
    setMonBadge('monBadgeB','idle');
    setPumpCardActive(1, targetA>0); setPumpCardActive(2,false);
    const segA=document.getElementById('monSegA'); const segB=document.getElementById('monSegB');
    if (segA){segA.style.width='0%';segA.classList.remove('has-b');} if (segB) segB.style.width='0%';
}
function resetMonitorUI() {
    if (dispensing) { showStatus('Cannot reset while dispensing.','danger'); return; }
    stopProgressPoll(); stopElapsedTimer();
    setFlaskFill('flaskFillA',0); setFlaskFill('flaskFillB',0);
    setDrip('dripA',false); setDrip('dripB',false);
    setMonBadge('monBadgeA','idle'); setMonBadge('monBadgeB','idle');
    setPumpCardActive(1,false); setPumpCardActive(2,false);
    const segA=document.getElementById('monSegA'); const segB=document.getElementById('monSegB');
    if (segA){segA.style.width='0%';segA.classList.remove('has-b');} if (segB) segB.style.width='0%';
    clearSensorWarning();
    showStatus('Monitor reset. System ready.','info');
}
function resetMonitor() { resetMonitorUI(); }

// ── Status box ────────────────────────────────────────────────
function showStatus(message, type='info') {
    const el = document.getElementById('statusBox');
    if (el) { el.textContent = message; el.className = `live-monitor status-${type}`; }
}

// ── Sensor warning ────────────────────────────────────────────
function showSensorWarning(seconds) {
    let banner = document.getElementById('sensorWarningBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'sensorWarningBanner';
        banner.className = 'sensor-warning-banner';
        const sb = document.getElementById('statusBox');
        if (sb && sb.parentNode) sb.parentNode.insertBefore(banner, sb);
    }
    banner.innerHTML = `<svg width="16" height="16"><use href="#icon-warning"/></svg><span class="swb-text"><strong>No flow detected after ${seconds}s.</strong> Sensor may not be connected. <strong>Press Emergency Stop to halt.</strong></span>`;
    banner.style.display = 'flex';
    showStatus(`SENSOR WARNING — No flow after ${seconds}s. Press Emergency Stop.`, 'warning');
}
function hideSensorWarning() {
    const b = document.getElementById('sensorWarningBanner');
    if (b) b.style.display = 'none';
    showStatus('Flow detected — sensor active.', 'info');
}
function clearSensorWarning() {
    const b = document.getElementById('sensorWarningBanner');
    if (b) b.style.display = 'none';
}

// ── ESP32 status ──────────────────────────────────────────────
function checkESP32Status() {
    fetch('/esp32/status', { cache:'no-store' })
        .then(r => r.json())
        .then(data => {
            const ok   = data.status === 'connected';
            const span = document.getElementById('connectionStatus');
            const dot  = document.getElementById('statusDot');
            const btn  = document.getElementById('dispenseBtn');
            if (span) span.textContent = ok ? 'Controller Online' : 'Controller Offline';
            if (dot)  dot.className    = 'status-dot ' + (ok ? 'connected' : 'error');
            if (btn && !dispensing) btn.disabled = !ok;
        })
        .catch(() => {
            const span = document.getElementById('connectionStatus');
            const dot  = document.getElementById('statusDot');
            const btn  = document.getElementById('dispenseBtn');
            if (span) span.textContent = 'Controller Offline';
            if (dot)  dot.className    = 'status-dot error';
            if (btn && !dispensing) btn.disabled = true;
        });
}
setInterval(checkESP32Status, 2000);

// ── Analytics ─────────────────────────────────────────────────
let _analyticsFilterFrom = null;
let _analyticsFilterTo   = null;

function openAnalyticsModal() {
    new bootstrap.Modal(document.getElementById('analyticsModal')).show();
    fetch('/analytics')
        .then(r => r.json())
        .then(data => {
            _analyticsRawData = data;
            renderAnalytics(data, _analyticsFilterFrom, _analyticsFilterTo);
        })
        .catch(() => {
            document.getElementById('analyticsSummary').innerHTML =
                '<div style="color:var(--danger);font-family:var(--font-mono);font-size:0.8rem;">Failed to load analytics.</div>';
        });
}

function applyAnalyticsFilter() {
    _analyticsFilterFrom = document.getElementById('analyticsDateFrom')?.value || null;
    _analyticsFilterTo   = document.getElementById('analyticsDateTo')?.value   || null;
    if (_analyticsRawData) renderAnalytics(_analyticsRawData, _analyticsFilterFrom, _analyticsFilterTo);
}
function clearAnalyticsFilter() {
    _analyticsFilterFrom = null; _analyticsFilterTo = null;
    const f = document.getElementById('analyticsDateFrom'); if(f) f.value='';
    const t = document.getElementById('analyticsDateTo');   if(t) t.value='';
    if (_analyticsRawData) renderAnalytics(_analyticsRawData, null, null);
}

function renderAnalytics(data, fromDate, toDate) {
    let byDate = data.by_date || [];

    // Apply date range filter
    if (fromDate) byDate = byDate.filter(d => d.date >= fromDate);
    if (toDate)   byDate = byDate.filter(d => d.date <= toDate);

    const total  = byDate.reduce((a,d)=>a+d.total_ml,0);
    const count  = byDate.reduce((a,d)=>a+d.count,0);
    const estops = byDate.reduce((a,d)=>a+d.emergency_stops,0);

    document.getElementById('analyticsSummary').innerHTML = `
        <div class="analytics-card"><div class="analytics-card-label">Total Dispensed</div><div class="analytics-card-val">${total.toFixed(0)} mL</div></div>
        <div class="analytics-card"><div class="analytics-card-label">Dispense Events</div><div class="analytics-card-val">${count}</div></div>
        <div class="analytics-card"><div class="analytics-card-label">Emergency Stops</div><div class="analytics-card-val" style="color:var(--danger)">${estops}</div></div>
        <div class="analytics-card"><div class="analytics-card-label">Days Active</div><div class="analytics-card-val">${byDate.length}</div></div>`;

    const ctx = document.getElementById('analyticsChart').getContext('2d');
    if (analyticsChartInst) { analyticsChartInst.destroy(); analyticsChartInst = null; }
    const isDark     = document.documentElement.getAttribute('data-theme') === 'dark';
    const gridColor  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    const tickColor  = isDark ? '#6e7681' : '#8a92a0';
    const labelColor = isDark ? '#e6edf3' : '#1a1d23';
    analyticsChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: byDate.map(d => d.date),
            datasets: [
                { label: reagentNames.A, data: byDate.map(d=>d.reagent_a_ml), backgroundColor:'rgba(59,130,246,0.7)', borderColor:'#3b82f6', borderWidth:1, borderRadius:4 },
                { label: reagentNames.B, data: byDate.map(d=>d.reagent_b_ml), backgroundColor:'rgba(16,185,129,0.7)', borderColor:'#10b981', borderWidth:1, borderRadius:4 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: labelColor, font:{ family:"'IBM Plex Mono'" } } },
                tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} mL` } }
            },
            scales: {
                x: { stacked:true, ticks:{ color:tickColor, font:{family:"'IBM Plex Mono'",size:11} }, grid:{color:gridColor} },
                y: { stacked:true, ticks:{ color:tickColor, font:{family:"'IBM Plex Mono'",size:11}, callback:v=>v+' mL' }, grid:{color:gridColor} }
            }
        }
    });

    // Operator table — with avg duration column (NEW)
    const opDiv = document.getElementById('analyticsOperatorTable');
    if (data.role === 'admin' && data.by_operator?.length > 0) {
        const rows = data.by_operator.map(op => {
            const avgDur = op.avg_duration_s != null
                ? `${Math.floor(op.avg_duration_s/60).toString().padStart(2,'0')}:${Math.floor(op.avg_duration_s%60).toString().padStart(2,'0')}`
                : '—';
            return `<tr>
                <td>${op.operator}</td>
                <td class="text-end" style="font-family:var(--font-mono)">${op.total_ml.toFixed(1)} mL</td>
                <td class="text-end" style="font-family:var(--font-mono)">${op.count}</td>
                <td class="text-end" style="font-family:var(--font-mono)">${avgDur}</td>
                <td class="text-end" style="font-family:var(--font-mono);color:var(--${op.emergency_stops>0?'danger':'text-3'})">${op.emergency_stops}</td>
            </tr>`;
        }).join('');
        opDiv.innerHTML = `
            <div style="margin-top:20px">
                <div class="section-label mb-2">By Operator</div>
                <table class="table dash-table">
                    <thead><tr><th>Operator</th><th class="text-end">Total</th><th class="text-end">Events</th><th class="text-end">Avg Duration</th><th class="text-end">E-Stops</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    } else {
        opDiv.innerHTML = '';
    }
}

// ── Inventory ─────────────────────────────────────────────────
function openInventoryModal() {
    new bootstrap.Modal(document.getElementById('inventoryModal')).show();
    loadInventory(true);
}
function loadInventory(renderModal=false) {
    fetch('/inventory')
        .then(r => r.json())
        .then(items => {
            const low    = items.filter(i => i.current_ml <= i.warn_threshold_ml);
            const banner = document.getElementById('inventoryWarningBanner');
            const txt    = document.getElementById('inventoryWarningText');
            if (low.length > 0 && banner && txt) {
                const names = low.map(i => `${i.reagent==='A'?reagentNames.A:reagentNames.B} (${i.current_ml.toFixed(0)}/${i.warn_threshold_ml.toFixed(0)} mL)`).join(', ');
                txt.textContent = `Low stock: ${names}`;
                banner.style.display = 'flex';
            } else if (banner) {
                banner.style.display = 'none';
            }
            if (!renderModal) return;
            const body = document.getElementById('inventoryBody');
            if (!body) return;
            body.innerHTML = items.map(item => {
                const name     = item.reagent==='A' ? reagentNames.A : reagentNames.B;
                const pct      = item.capacity_ml > 0 ? (item.current_ml/item.capacity_ml*100) : 0;
                const isLow    = item.current_ml <= item.warn_threshold_ml;
                const barColor = isLow ? 'var(--danger)' : (item.reagent==='A'?'var(--reagent-a)':'var(--reagent-b)');
                const adminCfg = currentUserRole==='admin' ? `
                    <div class="inv-configure-form" id="invCfg-${item.reagent}" style="display:none">
                        <div class="row g-2 mt-2">
                            <div class="col-4"><label class="dash-label">Capacity (mL)</label>
                                <input type="number" class="dash-input" id="invCap-${item.reagent}" value="${item.capacity_ml}" min="1"></div>
                            <div class="col-4"><label class="dash-label">Current (mL)</label>
                                <input type="number" class="dash-input" id="invCur-${item.reagent}" value="${item.current_ml.toFixed(0)}" min="0" max="${item.capacity_ml}"></div>
                            <div class="col-4"><label class="dash-label">Warn below (mL)</label>
                                <input type="number" class="dash-input" id="invWarn-${item.reagent}" value="${item.warn_threshold_ml}" min="0"></div>
                        </div>
                        <div class="mt-2 d-flex gap-2">
                            <button class="btn-modal-confirm" onclick="saveInvConfig('${item.reagent}')">Save</button>
                            <button class="btn-modal-cancel" onclick="document.getElementById('invCfg-${item.reagent}').style.display='none'">Cancel</button>
                        </div>
                    </div>` : '';
                return `
                    <div class="inv-item" style="margin-bottom:20px">
                        <div class="d-flex justify-content-between align-items-center mb-1">
                            <span class="inv-name">${name}</span>
                            <span class="inv-vol ${isLow?'inv-low':''}">${item.current_ml.toFixed(0)} / ${item.capacity_ml.toFixed(0)} mL</span>
                        </div>
                        <div class="inv-bar-wrap">
                            <div class="inv-bar-fill" style="width:${Math.min(pct,100).toFixed(1)}%;background:${barColor}"></div>
                        </div>
                        ${isLow?`<div class="inv-warn-msg"><svg width="12" height="12" style="vertical-align:-1px"><use href="#icon-warning"/></svg> Below warning threshold (${item.warn_threshold_ml.toFixed(0)} mL)</div>`:''}
                        <div class="d-flex gap-2 mt-2">
                            <input type="number" class="dash-input" id="refillAmt-${item.reagent}" placeholder="Refill amount (mL)" min="1" style="max-width:180px">
                            <button class="btn-modal-confirm" onclick="refillReagent('${item.reagent}')">+ Refill</button>
                            ${currentUserRole==='admin'?`<button class="btn-modal-cancel" onclick="document.getElementById('invCfg-${item.reagent}').style.display=''">Configure</button>`:''}
                        </div>
                        ${adminCfg}
                    </div>`;
            }).join('<hr style="border-color:var(--border)">');
        })
        .catch(() => {
            const body = document.getElementById('inventoryBody');
            if (body) body.innerHTML = '<div style="color:var(--danger);font-family:var(--font-mono);font-size:0.8rem;">Failed to load inventory.</div>';
        });
}
function refillReagent(reagent) {
    const amt = parseFloat(document.getElementById(`refillAmt-${reagent}`)?.value);
    if (!amt || amt <= 0) { showStatus('Enter a valid refill amount.', 'danger'); return; }
    fetch('/inventory/update', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'refill', reagent, amount_ml: amt })
    })
    .then(r => r.json())
    .then(d => {
        if (d.status==='success') { loadInventory(true); showStatus(`${reagent==='A'?reagentNames.A:reagentNames.B} refilled by ${amt} mL.`, 'success'); }
        else showStatus(d.message, 'danger');
    })
    .catch(() => showStatus('Refill failed.','danger'));
}
function saveInvConfig(reagent) {
    const capacity = parseFloat(document.getElementById(`invCap-${reagent}`)?.value);
    const current  = parseFloat(document.getElementById(`invCur-${reagent}`)?.value);
    const warn     = parseFloat(document.getElementById(`invWarn-${reagent}`)?.value);
    fetch('/inventory/update', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'configure', reagent, capacity_ml:capacity, current_ml:current, warn_threshold_ml:warn })
    })
    .then(r => r.json())
    .then(d => {
        if (d.status==='success') { loadInventory(true); showStatus('Inventory configured.','success'); }
        else showStatus(d.message,'danger');
    });
}

// ── Print / PDF report ────────────────────────────────────────
function printReport() {
    fetch('/report')
        .then(r => r.json())
        .then(data => {
            const nameA  = data.reagent_a_name || 'Reagent A';
            const nameB  = data.reagent_b_name || 'Reagent B';
            const inv    = (data.inventory || []).map(i =>
                `<tr><td>${i.reagent==='A'?nameA:nameB}</td><td>${i.current_ml.toFixed(0)} mL</td><td>${i.capacity_ml.toFixed(0)} mL</td><td>${i.warn_threshold_ml.toFixed(0)} mL</td></tr>`
            ).join('');
            const totalA = data.records.reduce((a,r)=>a+(r.dispensed_reagent_a_ml||0),0);
            const totalB = data.records.reduce((a,r)=>a+(r.dispensed_reagent_b_ml||0),0);
            const rows   = data.records.map(r => {
                const a   = (r.dispensed_reagent_a_ml||0).toFixed(1);
                const b   = (r.dispensed_reagent_b_ml||0).toFixed(1);
                const tot = ((r.dispensed_reagent_a_ml||0)+(r.dispensed_reagent_b_ml||0)).toFixed(1);
                const st  = r.status==='COMPLETED'
                    ? '<span style="color:#10b981">Completed</span>'
                    : '<span style="color:#ef4444">E-Stop</span>';
                const note = r.note ? `<br><span style="color:#888;font-size:10px">${r.note}</span>` : '';
                return `<tr><td>${r.start_time||'—'}${note}</td><td>${r.operator||'—'}</td><td>${a}</td><td>${b}</td><td>${tot}</td><td>${st}</td></tr>`;
            }).join('');
            const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>AMRDS Dispense Report</title>
<style>
  body{font-family:"IBM Plex Sans",Arial,sans-serif;font-size:12px;color:#1a1d23;margin:0;padding:20px;}
  h1{font-size:18px;margin-bottom:4px;}h2{font-size:13px;margin:20px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;color:#444;}
  .meta{font-size:11px;color:#666;margin-bottom:20px;}
  table{width:100%;border-collapse:collapse;margin-bottom:16px;}
  th,td{padding:5px 8px;border:1px solid #ddd;text-align:left;font-size:11px;}
  th{background:#f5f5f5;font-weight:600;}tr:nth-child(even)td{background:#fafafa;}
  .summary-row{display:flex;gap:20px;margin-bottom:16px;}
  .summary-card{border:1px solid #ddd;border-radius:6px;padding:10px 16px;min-width:120px;}
  .summary-card .label{font-size:10px;color:#888;text-transform:uppercase;}
  .summary-card .val{font-size:18px;font-weight:600;margin-top:2px;font-family:"IBM Plex Mono",monospace;}
  @media print{@page{margin:15mm;}}
</style></head><body>
<h1>AMRDS Dispense Report</h1>
<div class="meta">Generated: ${data.generated_at} | By: ${data.generated_by} | Role: ${data.role}</div>
<div class="summary-row">
  <div class="summary-card"><div class="label">Total ${nameA}</div><div class="val">${totalA.toFixed(1)} mL</div></div>
  <div class="summary-card"><div class="label">Total ${nameB}</div><div class="val">${totalB.toFixed(1)} mL</div></div>
  <div class="summary-card"><div class="label">Records</div><div class="val">${data.records.length}</div></div>
</div>
${inv?`<h2>Reagent Inventory</h2><table><thead><tr><th>Reagent</th><th>Current</th><th>Capacity</th><th>Warn Below</th></tr></thead><tbody>${inv}</tbody></table>`:''}
<h2>Dispense Records</h2>
<table><thead><tr><th>Timestamp / Note</th><th>Operator</th><th>${nameA} (mL)</th><th>${nameB} (mL)</th><th>Total (mL)</th><th>Status</th></tr></thead>
<tbody>${rows||'<tr><td colspan="6" style="text-align:center;color:#888">No records</td></tr>'}</tbody></table>
<script>window.onload=()=>{window.print();}<\/script>
</body></html>`;
            const w = window.open('', '_blank');
            if (w) { w.document.write(html); w.document.close(); }
            else showStatus('Please allow popups to print the report.', 'warning');
        })
        .catch(() => showStatus('Failed to generate report.', 'danger'));
}

// ── History ───────────────────────────────────────────────────
function updateHistory(page=0) {
    fetch('/history')
        .then(r => r.json())
        .then(events => {
            const list = document.getElementById('historyList');
            list.innerHTML = '';
            if (!events.length) {
                list.innerHTML = '<li class="log-empty">No dispense records found.</li>';
                _set('pageInfo','Page 1');
                document.getElementById('prevHistory').disabled = true;
                document.getElementById('nextHistory').disabled = true;
                return;
            }
            currentHistoryPage = page;
            const start = page*historyPerPage, end = start+historyPerPage;
            const total = Math.ceil(events.length/historyPerPage);
            events.slice(start, end).forEach(ev => {
                const li     = document.createElement('li');
                li.className = 'log-item '+(ev.type==='DISPENSE'?'log-completed':'log-emergency');
                const tLabel = ev.type==='DISPENSE' ? 'COMPLETED' : 'EMERGENCY STOP';
                const tClass = ev.type==='DISPENSE' ? 'type-completed' : 'type-emergency';
                const delBtn = currentUserRole==='admin'
                    ? `<button class="log-delete-btn" onclick="deleteHistory(${ev.id})" title="Delete record">
                           <svg width="11" height="11"><use href="#icon-trash"/></svg>
                       </button>` : '';
                // Note display + inline edit
                const noteHtml = `
                    <div class="log-note-row" id="noteRow-${ev.id}">
                        <span class="log-note-text" id="noteText-${ev.id}">${ev.note ? `<svg width="11" height="11" style="vertical-align:-1px;opacity:.6"><use href="#icon-note"/></svg> ${ev.note}` : ''}</span>
                        <button class="log-note-edit-btn" onclick="toggleNoteEdit(${ev.id}, '${(ev.note||'').replace(/'/g,"\\'")}')" title="Edit note">
                            <svg width="11" height="11"><use href="#icon-edit"/></svg>
                        </button>
                    </div>
                    <div class="log-note-edit" id="noteEdit-${ev.id}" style="display:none">
                        <input type="text" class="dash-input log-note-input" id="noteInput-${ev.id}"
                               maxlength="500" placeholder="Add a note…" value="${(ev.note||'').replace(/"/g,'&quot;')}">
                        <div class="log-note-actions">
                            <button class="btn-modal-confirm" style="padding:4px 10px;font-size:.72rem" onclick="saveNote(${ev.id})">Save</button>
                            <button class="btn-modal-cancel"  style="padding:4px 10px;font-size:.72rem" onclick="cancelNoteEdit(${ev.id})">Cancel</button>
                        </div>
                    </div>`;
                li.innerHTML = `
                    <div class="log-item-content">
                        <div class="log-type ${tClass}">${tLabel}</div>
                        <div class="log-message">${ev.message}</div>
                        ${noteHtml}
                        <div class="log-meta">
                            <span class="log-operator">
                                <svg width="11" height="11" style="vertical-align:-1px"><use href="#icon-user"/></svg>
                                ${ev.operator||'unknown'}
                            </span>
                            <span class="log-time">${ev.timestamp}</span>
                            ${ev.end_time?`<span class="log-time">→ ${ev.end_time}</span>`:''}
                        </div>
                    </div>${delBtn}`;
                list.appendChild(li);
            });
            _set('pageInfo',`Page ${page+1} / ${total}`);
            document.getElementById('prevHistory').disabled = (currentHistoryPage===0);
            document.getElementById('nextHistory').disabled = (end>=events.length);
        })
        .catch(() => {
            document.getElementById('historyList').innerHTML =
                '<li class="log-empty">Failed to load records.</li>';
        });
}

// ── History note editing (NEW) ────────────────────────────────
function toggleNoteEdit(id, currentNote) {
    document.getElementById(`noteRow-${id}`).style.display  = 'none';
    document.getElementById(`noteEdit-${id}`).style.display = '';
    const inp = document.getElementById(`noteInput-${id}`);
    if (inp) { inp.value = currentNote || ''; inp.focus(); }
}
function cancelNoteEdit(id) {
    document.getElementById(`noteRow-${id}`).style.display  = '';
    document.getElementById(`noteEdit-${id}`).style.display = 'none';
}
function saveNote(id) {
    const note = document.getElementById(`noteInput-${id}`)?.value?.trim() || '';
    fetch(`/history/${id}/note`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ note })
    })
    .then(r => r.json())
    .then(d => {
        if (d.status === 'success') {
            updateHistory(currentHistoryPage);
            showStatus('Note saved.', 'success');
        } else {
            showStatus(d.message || 'Failed to save note.', 'danger');
        }
    })
    .catch(() => showStatus('Failed to save note.', 'danger'));
}

function prevHistory() { if (currentHistoryPage>0) updateHistory(currentHistoryPage-1); }
function nextHistory() { updateHistory(currentHistoryPage+1); }
function deleteHistory(id) {
    if (!confirm('Delete this record?')) return;
    fetch(`/delete-history/${id}`, {method:'DELETE'})
        .then(r=>r.json())
        .then(d => { if (d.status==='success'){showStatus('Record deleted.','success');updateHistory(currentHistoryPage);}else showStatus(d.message,'danger'); });
}
function clearHistory() {
    if (!confirm('Clear all records?')) return;
    fetch('/clear-history',{method:'POST'}).then(r=>r.json())
        .then(d => { if(d.status==='success'){showStatus('Log cleared.','success');updateHistory(0);}else showStatus(d.message,'danger'); });
}
function exportCSV() {
    fetch('/history').then(r=>r.json()).then(events => {
        if (!events.length){showStatus('No records to export.','info');return;}
        const rows = events.map(e=>[e.id,`"${e.timestamp}"`,e.type,`"${e.message.replace(/"/g,'""')}"`,`"${(e.note||'').replace(/"/g,'""')}"`].join(','));
        const csv  = ['ID,Timestamp,Type,Message,Note',...rows].join('\n');
        const blob = new Blob([csv],{type:'text/csv'});
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'),{href:url,download:`dispense_log_${new Date().toISOString().slice(0,10)}.csv`});
        a.click(); URL.revokeObjectURL(url);
        showStatus('Log exported.','success');
    });
}

// ── User Management ───────────────────────────────────────────
function openUserModal() { loadUsers(); new bootstrap.Modal(document.getElementById('userModal')).show(); }
function loadUsers() {
    fetch('/users').then(r=>r.json()).then(users => {
        const self  = document.getElementById('operatorName')?.textContent?.trim()||'';
        const tbody = document.getElementById('userTableBody');
        tbody.innerHTML = '';
        users.forEach(u => {
            const isSelf = u.username===self;
            tbody.innerHTML += `<tr>
                <td>${u.id}</td><td><strong>${u.username}</strong></td>
                <td><span class="nav-role-pill role-${u.role}">${u.role.toUpperCase()}</span></td>
                <td>${u.created_at||'—'}</td>
                <td>${!isSelf?`<button class="btn btn-sm btn-outline-danger" onclick="removeUser(${u.id},'${u.username}')">
                    <svg width="11" height="11" style="vertical-align:-1px"><use href="#icon-trash"/></svg> Remove</button>`
                    :'<span style="font-size:0.75rem;color:var(--text-3)">(you)</span>'}</td>
            </tr>`;
        });
    }).catch(() => { document.getElementById('userTableBody').innerHTML='<tr><td colspan="5" class="text-center text-muted">Failed to load users.</td></tr>'; });
}
function addUser() {
    const username=document.getElementById('newUsername').value.trim();
    const password=document.getElementById('newPassword').value;
    const role    =document.getElementById('newRole').value;
    if (!username||!password){showUserMsg('Username and password required.','danger');return;}
    fetch('/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,role})})
        .then(r=>r.json()).then(d=>{if(d.status==='success'){showUserMsg(d.message,'success');document.getElementById('newUsername').value='';document.getElementById('newPassword').value='';loadUsers();}else showUserMsg(d.message,'danger');});
}
function removeUser(id,username) {
    if (!confirm(`Remove user "${username}"?`)) return;
    fetch(`/users/${id}`,{method:'DELETE'}).then(r=>r.json()).then(d=>{if(d.status==='success'){showUserMsg(`User "${username}" removed.`,'success');loadUsers();}else showUserMsg(d.message,'danger');});
}
function showUserMsg(msg,type) {
    const el=document.getElementById('userFormMsg');
    if (!el) return;
    el.innerHTML=`<span class="user-msg user-msg-${type}">${msg}</span>`;
    setTimeout(()=>el.innerHTML='',4000);
}

// ── Change Password ───────────────────────────────────────────
function openChangePasswordModal() {
    ['currentPassword','newPasswordChange','confirmNewPassword'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const msg=document.getElementById('changePasswordMsg');if(msg)msg.innerHTML='';
    new bootstrap.Modal(document.getElementById('changePasswordModal')).show();
}
function submitChangePassword() {
    const current=document.getElementById('currentPassword').value;
    const newPwd =document.getElementById('newPasswordChange').value;
    const confirm=document.getElementById('confirmNewPassword').value;
    if (!current||!newPwd||!confirm){showCPMsg('All fields are required.','danger');return;}
    if (newPwd!==confirm){showCPMsg('Passwords do not match.','danger');return;}
    if (newPwd.length<6){showCPMsg('Minimum 6 characters.','danger');return;}
    fetch('/change-password',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({current_password:current,new_password:newPwd})})
        .then(r=>r.json()).then(d=>{
            if(d.status==='success'){showCPMsg('Updated. Signing out…','success');
                setTimeout(()=>{fetch('/logout',{method:'POST'}).finally(()=>{window.location.href='/login';});},1800);}
            else showCPMsg(d.message,'danger');
        }).catch(()=>showCPMsg('Request failed.','danger'));
}
function showCPMsg(msg,type){const el=document.getElementById('changePasswordMsg');if(el)el.innerHTML=`<span class="user-msg user-msg-${type}">${msg}</span>`;}

// ── User Dropdown ─────────────────────────────────────────────
function toggleUserDropdown(){document.getElementById('userDropdownWrap')?.classList.toggle('open');}
function closeUserDropdown(){document.getElementById('userDropdownWrap')?.classList.remove('open');}
document.addEventListener('click',e=>{const w=document.getElementById('userDropdownWrap');if(w&&!w.contains(e.target))w.classList.remove('open');});

// ── DOMContentLoaded ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    // Bidirectional slider+number binding
    bindSlider('waterSlider', 'waterNumberInput');
    bindSlider('syrupSlider', 'syrupNumberInput');

    Promise.all([
        fetch('/session-info').then(r=>r.json()),
        fetch('/settings/reagent-names').then(r=>r.json())
    ])
    .then(([sess, names]) => {
        applyRoleUI(sess.role);
        applyReagentNames(names.a, names.b);
    })
    .catch(() => showSessionExpired())
    .finally(() => {
        updateSummary();
        resetMonitorUI();
        checkESP32Status();
        loadProtocols();
        loadInventory(false);

        // ── Page reload recovery ─────────────────────────────
        // If page reloaded during active dispense, resume monitoring
        // and re-enable refresh lock + overlay
        _origFetch('/progress').then(r=>r.json()).then(prog => {
            if (prog.active) {
                dispensing = true;
                _setRefreshLock(true);
                const btn = document.getElementById('dispenseBtn');
                if (btn) btn.disabled = true;
                _set('dispenseBtnText', 'Dispensing…');
                // Fake a single-step context for the recovery overlay
                _overlayTotalSteps  = 1;
                _overlayCurrentStep = 1;
                _overlayStartTime   = Date.now();
                _ovSetState('dispensing');
                showDispenseOverlay();
                _set('ovStepLabel', 'Dispense in progress');
                _set('ovStepNote',  'Page was reloaded — monitoring resumed');
                _set('ovStepBadge', 'Resuming…');
                // Start elapsed timer
                if (_overlayElapsedTimer) clearInterval(_overlayElapsedTimer);
                _overlayElapsedTimer = setInterval(() => {
                    if (!_overlayStartTime) return;
                    const s=Math.floor((Date.now()-_overlayStartTime)/1000);
                    const fmt=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
                    _set('ovElapsed',fmt); _set('ovElapsed2',fmt);
                }, 500);
                const pumpNum = prog.target_a > 0 && prog.pct_a < 100 ? 1 : 2;
                const label   = pumpNum===1 ? reagentNames.A : reagentNames.B;
                const volume  = pumpNum===1 ? (prog.target_a||0) : (prog.target_b||0);
                startProgressPoll(pumpNum, label, volume)
                    .then(() => finishDispense(prog.target_a||0, prog.target_b||0))
                    .catch(err => {
                        if (err.message !== 'Emergency stop detected') {
                            resetDispenseUI();
                            hideDispenseOverlay();
                        }
                    });
            }
        }).catch(() => {});
    });
});