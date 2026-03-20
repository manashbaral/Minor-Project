// ============================================================
//  AMRDS — script.js  (v3 — real-data driven monitor)
//
//  Architecture change (v3):
//  BEFORE: Two parallel systems
//    - monTick (setInterval 100ms) — fake math simulation driving flask/vol UI
//    - progressInterval (500ms)   — real /progress data driving only the status text
//    Problems:
//      • Flask fill and vol numbers showed fake math, not real sensor data
//      • The /progress "dispensed" value stayed 0 with no sensors connected,
//        so pct never reached 100%, the stage never resolved, pump ran forever
//      • Bottom combined bar always showed 0 because it was fed from monTick vars
//        that were never updated from the poll
//
//  AFTER (v3): One unified system
//    - Single setInterval (500ms) polls /progress
//    - ALL UI driven exclusively from that real data:
//        flask fill, vol display, progress bar, combined bar, badges, status text
//    - monTick simulation REMOVED entirely
//    - Completion triggered by prog.active === false (set by Flask when ESP32
//      calls /complete, which happens when the pump stops itself) OR pct >= 100
//    - Elapsed timer is still client-side (Date.now delta) — always accurate
// ============================================================

// ============================================================
//  Globals
// ============================================================
let dispensing         = false;
let progressInterval   = null;
let elapsedTimer       = null;
let currentHistoryPage = 0;
const historyPerPage   = 3;
let currentUserRole    = null;
let _renameModalInst   = null;
let reagentNames       = { A: 'Reagent A', B: 'Reagent B' };
let dispenseStartTime  = null;

// ============================================================
//  Tiny helpers
// ============================================================
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

// ============================================================
//  Auth
// ============================================================
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

// ============================================================
//  Role UI
// ============================================================
function applyRoleUI(role) {
    currentUserRole = role;
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = role === 'admin' ? '' : 'none';
    });
}

// ============================================================
//  Theme
// ============================================================
function toggleDarkMode() {
    const html   = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    _set('darkModeIcon', isDark ? '🌙' : '☀');
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
}

function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    _set('darkModeIcon', saved === 'dark' ? '☀' : '🌙');
}

// ============================================================
//  Log Drawer
// ============================================================
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

// ============================================================
//  Reagent Rename
// ============================================================
let renamingReagent = null;

function openRenameModal(reagent) {
    renamingReagent = reagent;
    _set('renameModalTitle', `Rename Reagent ${reagent}`);
    document.getElementById('renameInput').value = reagentNames[reagent];
    _renameModalInst = new bootstrap.Modal(document.getElementById('renameModal'));
    _renameModalInst.show();
}

function applyRename() {
    const val = document.getElementById('renameInput').value.trim();
    if (!val) return;
    reagentNames[renamingReagent] = val;
    const isA = renamingReagent === 'A';
    const ids = isA
        ? ['labelReagentA','summaryLabelA','summaryLabelA2','vesselLabelA','monLegendA','pump1ReagentLabel']
        : ['labelReagentB','summaryLabelB','summaryLabelB2','vesselLabelB','monLegendB','pump2ReagentLabel'];
    ids.forEach(id => _set(id, val));
    updateSummary();
    if (_renameModalInst) { _renameModalInst.hide(); _renameModalInst = null; }
    showStatus(`Reagent ${renamingReagent} renamed to "${val}".`, 'info');
}

// ============================================================
//  Volume & Ratio Summary
// ============================================================
function updateSummary() {
    const a = Number(document.getElementById('waterSlider').value);
    const b = Number(document.getElementById('syrupSlider').value);
    _set('summaryVolA',  `${a} ml`);
    _set('summaryVolB',  `${b} ml`);
    _set('summaryTotal', `${a + b} ml`);

    let ratio = '— : —';
    if (a > 0 && b > 0) {
        const gcd = (x, y) => y === 0 ? x : gcd(y, x % y);
        const g   = gcd(a, b);
        ratio     = `${a / g} : ${b / g}`;
    } else if (a > 0) ratio = 'A only';
    else if (b > 0)   ratio = 'B only';
    _set('summaryRatio', ratio);

    const total = a + b;
    const segA  = document.getElementById('ratioSegA');
    const segB  = document.getElementById('ratioSegB');
    if (segA) segA.style.width = (total > 0 ? (a / total * 100).toFixed(1) : 0) + '%';
    if (segB) segB.style.width = (total > 0 ? (b / total * 100).toFixed(1) : 0) + '%';
}

// ============================================================
//  Sliders
// ============================================================
function bindSlider(sliderId, valueId) {
    const slider   = document.getElementById(sliderId);
    const valueBox = document.getElementById(valueId);
    if (!slider || !valueBox) return;
    slider.addEventListener('input', () => {
        valueBox.textContent = slider.value;
        updateSummary();
    });
}

function setPreset(a, b) {
    document.getElementById('waterSlider').value = a;
    document.getElementById('syrupSlider').value = b;
    _set('waterValue', a);
    _set('syrupValue', b);
    updateSummary();
    showStatus(`Protocol loaded: ${reagentNames.A} ${a} ml | ${reagentNames.B} ${b} ml`, 'info');
}

// ============================================================
//  Progress Bar (volume summary card)
// ============================================================
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

// ============================================================
//  Confirmation Modal
// ============================================================
function showConfirmModal(reagentA, reagentB, onConfirm) {
    _set('confirmLabelA', reagentNames.A);
    _set('confirmLabelB', reagentNames.B);
    _set('confirmVolA',   reagentA > 0 ? `${reagentA} ml` : 'SKIP');
    _set('confirmVolB',   reagentB > 0 ? `${reagentB} ml` : 'SKIP');
    _set('confirmTotal',  `${reagentA + reagentB} ml`);
    let ratio = '—';
    if (reagentA > 0 && reagentB > 0) {
        const gcd = (x, y) => y === 0 ? x : gcd(y, x % y);
        const g   = gcd(reagentA, reagentB);
        ratio     = `${reagentA / g} : ${reagentB / g}`;
    } else ratio = reagentA > 0 ? 'A only' : 'B only';
    _set('confirmRatio', ratio);
    _set('confirmSequence',
        reagentA > 0 && reagentB > 0 ? 'Pump 1 → 2s pause → Pump 2'
        : reagentA > 0 ? 'Pump 1 only' : 'Pump 2 only');

    const modal = new bootstrap.Modal(document.getElementById('confirmModal'));
    modal.show();
    const btn    = document.getElementById('confirmDispenseBtn');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => { modal.hide(); onConfirm(); });
}

// ============================================================
//  Flask Fill — SVG <rect> driven by fraction 0→1
//  viewBox: 0 0 100 150; flask base at y≈138, fillable height≈88
// ============================================================
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
    if (active) {
        el.classList.remove('drip-hidden');
        el.classList.add('drip-active');
        el.setAttribute('opacity', '0.9');
    } else {
        el.classList.add('drip-hidden');
        el.classList.remove('drip-active');
        el.setAttribute('opacity', '0');
    }
}

function setMonBadge(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    const map = { idle:'badge-idle', dispensing:'badge-dispensing', completed:'badge-completed', halted:'badge-halted' };
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

// ============================================================
//  Combined monitor progress bar
//  A-segment occupies targetA/(targetA+targetB) of total width,
//  B-segment occupies the rest. Each fills proportionally.
// ============================================================
function updateMonitorSegments(dispensedA, targetA, dispensedB, targetB) {
    const totalTarget = (targetA || 0) + (targetB || 0);
    if (totalTarget <= 0) return;

    const fracA  = targetA > 0 ? Math.min((dispensedA || 0) / targetA, 1) : (targetA === 0 ? 1 : 0);
    const fracB  = targetB > 0 ? Math.min((dispensedB || 0) / targetB, 1) : 0;
    const shareA = targetA / totalTarget;
    const shareB = targetB / totalTarget;

    const elA = document.getElementById('monSegA');
    const elB = document.getElementById('monSegB');

    if (elA) {
        elA.style.width = (fracA * shareA * 100).toFixed(2) + '%';
        if (targetB > 0) elA.classList.add('has-b');
        else             elA.classList.remove('has-b');
    }
    if (elB) elB.style.width = (fracB * shareB * 100).toFixed(2) + '%';
}

// ============================================================
//  Elapsed Timer — lightweight client-side display
// ============================================================
function startElapsedTimer() {
    stopElapsedTimer();
    dispenseStartTime = Date.now();
    elapsedTimer = setInterval(() => {
        if (!dispenseStartTime) return;
        _set('pillElapsed', ((Date.now() - dispenseStartTime) / 1000).toFixed(1) + 's');
    }, 200);
}

// ============================================================
//  UNIFIED PROGRESS POLL  ← the heart of v3
//
//  Replaces both the old monTick simulation AND the old
//  per-stage progressInterval. One function drives everything.
//
//  /progress returns:
//   { active, dispensed_a, dispensed_b, target_a, target_b, pct_a, pct_b }
//
//  Stage completion:
//   prog.active === false  — ESP32 stopped pump and called /complete,
//                            Flask set dispense_session active=False
//   pct >= 100             — fallback if /complete arrived before last poll
// ============================================================
function startProgressPoll(pumpNum, reagentLabel, volume) {
    stopProgressPoll();

    return new Promise((resolve, reject) => {
        let pollCount          = 0;
        let staleWarningActive = false;   // true = warning banner is pinned; suppress normal status
        const STALE_AFTER_POLLS = 20;     // 20 × 500ms = 10s of zero progress → warn

        progressInterval = setInterval(async () => {
            if (!dispensing) { stopProgressPoll(); return; }
            try {
                const res  = await _origFetch('/progress');
                const prog = await res.json();
                pollCount++;

                // ─── Pick values for the current pump ───
                const dispensed = pumpNum === 1 ? (prog.dispensed_a || 0) : (prog.dispensed_b || 0);
                const target    = pumpNum === 1 ? (prog.target_a    || 0) : (prog.target_b    || 0);
                const pct       = pumpNum === 1 ? (prog.pct_a       || 0) : (prog.pct_b       || 0);

                // ─── Stale sensor warning ───
                // Shown after 10s of zero progress (sensor likely not connected).
                // Once active, normal status updates are suppressed so the warning stays visible.
                // Clears automatically if real flow data starts arriving.
                if (!staleWarningActive && pollCount >= STALE_AFTER_POLLS && dispensed === 0) {
                    staleWarningActive = true;
                    showSensorWarning(STALE_AFTER_POLLS / 2);
                }
                if (staleWarningActive && dispensed > 0) {
                    staleWarningActive = false;
                    hideSensorWarning();
                }

                const volId    = pumpNum === 1 ? 'monVolA'    : 'monVolB';
                const tgtId    = pumpNum === 1 ? 'monTargetA' : 'monTargetB';
                const fillId   = pumpNum === 1 ? 'flaskFillA' : 'flaskFillB';
                const dripId   = pumpNum === 1 ? 'dripA'      : 'dripB';
                const msgId    = pumpNum === 1 ? 'monMsgA'    : 'monMsgB';
                const badgeId  = pumpNum === 1 ? 'monBadgeA'  : 'monBadgeB';
                const flowId   = pumpNum === 1 ? 'pillFlowA'  : 'pillFlowB';

                // ─── Update vol display ───
                _set(volId, dispensed.toFixed(2) + ' mL');
                _set(tgtId, '/ ' + (target > 0 ? target.toFixed(1) : volume.toFixed(1)) + ' mL');

                // ─── Flask fill (real fraction) ───
                const displayTarget = target > 0 ? target : volume;
                setFlaskFill(fillId, displayTarget > 0 ? dispensed / displayTarget : 0);

                // ─── Drip only while actively dispensing ───
                setDrip(dripId, true);

                // ─── Top progress bar ───
                setProgressPct(Math.min(pct, 100));

                // ─── Combined monitor bar ───
                updateMonitorSegments(
                    prog.dispensed_a || 0, prog.target_a || 0,
                    prog.dispensed_b || 0, prog.target_b || 0
                );

                // ─── Flow rate pill (approximate from elapsed) ───
                if (dispenseStartTime && dispensed > 0) {
                    const elapsed = (Date.now() - dispenseStartTime) / 1000;
                    _set(flowId, (dispensed / elapsed).toFixed(2) + ' mL/s');
                }

                // ─── Status text — suppressed while sensor warning banner is pinned ───
                if (!staleWarningActive) {
                    showStatus(
                        `[PUMP ${pumpNum}  ${reagentLabel}]  ${dispensed.toFixed(2)} / ${displayTarget.toFixed(1)} mL  (${pct.toFixed(1)}%)`,
                        'warning'
                    );
                }

                // ─── Completion check ───
                const isDone = !prog.active || pct >= 100;
                if (isDone) {
                    stopProgressPoll();
                    clearSensorWarning();

                    // Lock UI at final state
                    const finalVol = displayTarget;
                    setFlaskFill(fillId, 1);
                    setDrip(dripId, false);               // ← STOP drip animation
                    _set(volId, finalVol.toFixed(2) + ' mL');
                    setProgressPct(100);
                    setPumpCardActive(pumpNum, false);
                    setMonBadge(badgeId, 'completed');
                    _set(msgId, `Complete — ${finalVol.toFixed(2)} mL`);
                    _set(flowId, '0.00 mL/s');

                    // Final combined bar update
                    updateMonitorSegments(
                        pumpNum === 1 ? (prog.target_a || volume) : (prog.dispensed_a || 0),
                        prog.target_a || (pumpNum === 1 ? volume : 0),
                        pumpNum === 2 ? (prog.target_b || volume) : (prog.dispensed_b || 0),
                        prog.target_b || (pumpNum === 2 ? volume : 0)
                    );

                    showStatus(
                        `[PUMP ${pumpNum} DONE]  ${reagentLabel}: ${finalVol.toFixed(2)} mL dispensed`,
                        'success'
                    );
                    resolve({ dispensed: finalVol, target: displayTarget });
                }

            } catch (e) {
                console.warn('[progress poll]', e.message);
                // Don't reject on a single failed poll — keep retrying
            }
        }, 500);
    });
}

// ============================================================
//  Run a Single Pump Stage
// ============================================================
function runPumpStage(pumpNum, reagentLabel, volume, params) {
    return new Promise((resolve, reject) => {
        // Arm monitor UI
        setPumpCardActive(pumpNum, true);
        setMonBadge(pumpNum === 1 ? 'monBadgeA' : 'monBadgeB', 'dispensing');
        _set(pumpNum === 1 ? 'monMsgA' : 'monMsgB', `Dispensing ${reagentLabel}…`);
        setDrip(pumpNum === 1 ? 'dripA' : 'dripB', true);
        _set('pillPhase',    `Pump ${pumpNum} — ${reagentLabel}`);
        _set('pillSequence', 'In progress');

        // Show progress bar
        const c = document.getElementById('progressContainer');
        if (c) c.style.display = '';
        setProgressPct(0);

        // Send /dispense to Flask → ESP32
        fetch('/dispense', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(params)
        })
        .then(async res => {
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); }
            catch (_) {
                if (res.status === 401 || res.redirected) {
                    showSessionExpired();
                    throw new Error('Session expired.');
                }
                throw new Error('Unexpected server response. Check Flask logs.');
            }
            if (!res.ok) throw new Error(data.message || `Server error (${res.status})`);
            if (data.status !== 'started') throw new Error(data.message || 'Failed to start pump');
            return data;
        })
        .then(() => {
            showStatus(`[PUMP ${pumpNum} ACTIVE]  Dispensing ${reagentLabel}: ${volume} mL`, 'warning');
            // Hand off to unified poll — poll drives all UI from here
            startProgressPoll(pumpNum, reagentLabel, volume)
                .then(resolve)
                .catch(reject);
        })
        .catch(err => {
            setPumpCardActive(pumpNum, false);
            setDrip(pumpNum === 1 ? 'dripA' : 'dripB', false);
            reject(err);
        });
    });
}

// ============================================================
//  Main Dispense Sequence
// ============================================================
async function startDispensing() {
    const dot = document.getElementById('statusDot');
    if (!dot || !dot.classList.contains('connected')) {
        showStatus('Cannot initiate: Controller is disconnected.', 'danger');
        return;
    }
    if (dispensing) return;

    const reagentA = Number(document.getElementById('waterSlider').value);
    const reagentB = Number(document.getElementById('syrupSlider').value);
    if (reagentA === 0 && reagentB === 0) {
        showStatus('[ALERT] Both reagent volumes are zero. Set at least one volume before dispensing.', 'danger');
        return;
    }
    showConfirmModal(reagentA, reagentB, () => executeDispense(reagentA, reagentB));
}

async function executeDispense(reagentA, reagentB) {
    dispensing = true;

    const btn = document.getElementById('dispenseBtn');
    if (btn) btn.disabled = true;
    _set('dispenseBtnText', '⏳ Dispensing...');

    initMonitorUI(reagentA, reagentB);
    startElapsedTimer();

    try {
        // ── Stage 1: Pump 1 ──
        if (reagentA === 0) {
            setPumpCardActive(1, false);
            setMonBadge('monBadgeA', 'idle');
            _set('monMsgA', 'Skipped (0 mL)');
        } else {
            await runPumpStage(1, reagentNames.A, reagentA, { reagent_a: reagentA, reagent_b: 0 });
            if (!dispensing) return;
            if (reagentB > 0) {
                showStatus('[PAUSE]  Pump 1 complete. Switching to Pump 2 in 2 seconds…', 'info');
                _set('pillPhase', '2s idle gap');
                resetProgressBar();
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!dispensing) return;

        // ── Stage 2: Pump 2 ──
        if (reagentB === 0) {
            setPumpCardActive(2, false);
            setMonBadge('monBadgeB', 'idle');
            _set('monMsgB', 'Skipped (0 mL)');
        } else {
            await runPumpStage(2, reagentNames.B, reagentB, { reagent_a: 0, reagent_b: reagentB });
        }

        await finishDispense(reagentA, reagentB);

    } catch (error) {
        console.error('[executeDispense]', error);
        showStatus(`Error: ${error.message}`, 'danger');
        resetDispenseUI();
    }
}

// ============================================================
//  Emergency Stop
// ============================================================
function emergencyStop() {
    stopProgressPoll();
    stopElapsedTimer();
    dispensing = false;

    setPumpCardActive(1, false);
    setPumpCardActive(2, false);
    setDrip('dripA', false);
    setDrip('dripB', false);
    setMonBadge('monBadgeA', 'halted');
    setMonBadge('monBadgeB', 'halted');
    _set('pillSequence', 'Halted');
    _set('pillPhase',    '—');
    _set('pillFlowA',    '— mL/s');
    _set('pillFlowB',    '— mL/s');

    clearSensorWarning();
    showStatus('[EMERGENCY STOP]  All pumps halted. Inspect system before resuming.', 'danger');

    fetch('/emergency-stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ reason: 'Operator triggered emergency stop' })
    }).then(() => updateHistory()).catch(console.warn);

    resetDispenseUI(true);
}

// ============================================================
//  Finish Dispense
// ============================================================
async function finishDispense(reagentA, reagentB) {
    stopElapsedTimer();
    try {
        await fetch('/complete', { method: 'POST' });
        _set('pillSequence', 'Completed');
        _set('pillPhase',    'Done');
        _set('pillFlowA',    '0.00 mL/s');
        _set('pillFlowB',    '0.00 mL/s');
        showStatus(
            `[COMPLETE]  Sequence finished.  ${reagentNames.A}: ${reagentA} mL  |  ${reagentNames.B}: ${reagentB} mL`,
            'success'
        );
        updateHistory();
    } catch {
        showStatus('Warning: Could not confirm completion with server.', 'warning');
    }
    resetDispenseUI();
}

// ============================================================
//  Reset Dispense UI
// ============================================================
function resetDispenseUI(keepBar = false) {
    dispensing = false;
    const btn = document.getElementById('dispenseBtn');
    if (btn) btn.disabled = false;
    _set('dispenseBtnText', '▶ Initiate Dispense');
    if (!keepBar) resetProgressBar();
}

// ============================================================
//  Init Monitor UI — sets targets + clears previous state
//  Does NOT start any intervals.
// ============================================================
function initMonitorUI(targetA, targetB) {
    setFlaskFill('flaskFillA', 0);
    setFlaskFill('flaskFillB', 0);
    setDrip('dripA', false);
    setDrip('dripB', false);

    _set('monVolA',    '0.00 mL');
    _set('monVolB',    '0.00 mL');
    _set('monTargetA', '/ ' + (targetA > 0 ? targetA.toFixed(1) : '0.0') + ' mL');
    _set('monTargetB', '/ ' + (targetB > 0 ? targetB.toFixed(1) : '0.0') + ' mL');
    _set('monMsgA',    targetA > 0 ? `Dispensing ${reagentNames.A}…` : 'Skipped (0 mL)');
    _set('monMsgB',    targetB > 0 ? 'Waiting…'                      : 'Skipped (0 mL)');

    setMonBadge('monBadgeA', targetA > 0 ? 'dispensing' : 'idle');
    setMonBadge('monBadgeB', 'idle');
    setPumpCardActive(1, targetA > 0);
    setPumpCardActive(2, false);

    _set('pillSequence', 'Starting…');
    _set('pillPhase',    targetA > 0 ? `Pump 1 — ${reagentNames.A}` : `Pump 2 — ${reagentNames.B}`);
    _set('pillFlowA',    '— mL/s');
    _set('pillFlowB',    '— mL/s');
    _set('pillElapsed',  '0.0s');

    const segA = document.getElementById('monSegA');
    const segB = document.getElementById('monSegB');
    if (segA) { segA.style.width = '0%'; segA.classList.remove('has-b'); }
    if (segB)   segB.style.width = '0%';
}

// ============================================================
//  Reset Monitor (refresh button / page load)
// ============================================================
function resetMonitorUI() {
    if (dispensing) { showStatus('Cannot reset monitor while dispensing is active.', 'danger'); return; }
    stopProgressPoll();
    stopElapsedTimer();

    setFlaskFill('flaskFillA', 0);
    setFlaskFill('flaskFillB', 0);
    setDrip('dripA', false);
    setDrip('dripB', false);

    _set('monVolA',    '0.00 mL');
    _set('monVolB',    '0.00 mL');
    _set('monTargetA', '/ — mL');
    _set('monTargetB', '/ — mL');
    _set('monMsgA',    'Waiting to start…');
    _set('monMsgB',    'Waiting…');

    setMonBadge('monBadgeA', 'idle');
    setMonBadge('monBadgeB', 'idle');
    setPumpCardActive(1, false);
    setPumpCardActive(2, false);

    _set('pillSequence', 'Idle');
    _set('pillPhase',    '—');
    _set('pillFlowA',    '— mL/s');
    _set('pillFlowB',    '— mL/s');
    _set('pillElapsed',  '—');

    const segA = document.getElementById('monSegA');
    const segB = document.getElementById('monSegB');
    if (segA) { segA.style.width = '0%'; segA.classList.remove('has-b'); }
    if (segB)   segB.style.width = '0%';

    clearSensorWarning();
    showStatus('Monitor reset. System ready.', 'info');
}

function resetMonitor() { resetMonitorUI(); }

// ============================================================
//  Status Box
// ============================================================
function showStatus(message, type = 'info') {
    const el = document.getElementById('statusBox');
    if (el) { el.textContent = message; el.className = `live-monitor status-${type}`; }
}

// ============================================================
//  Sensor Warning Banner
//  A persistent, highly-visible banner that sits ABOVE the
//  status box while the stale-sensor condition is active.
//  Cleared when real flow data arrives or stop is pressed.
// ============================================================
function showSensorWarning(seconds) {
    let banner = document.getElementById('sensorWarningBanner');
    if (!banner) {
        // Create the banner and insert it just before the status box
        banner = document.createElement('div');
        banner.id        = 'sensorWarningBanner';
        banner.className = 'sensor-warning-banner';
        const statusBox = document.getElementById('statusBox');
        if (statusBox && statusBox.parentNode) {
            statusBox.parentNode.insertBefore(banner, statusBox);
        }
    }
    banner.innerHTML =
        `<span class="swb-icon">⚠</span>` +
        `<span class="swb-text">` +
            `<strong>No flow detected after ${seconds}s.</strong> ` +
            `Flow sensor may not be connected. ` +
            `The pump is running but cannot measure output. ` +
            `<strong>Press Emergency Stop to halt the pump.</strong>` +
        `</span>`;
    banner.style.display = 'flex';

    // Also update the status box so it echoes the warning
    showStatus(
        `⚠ SENSOR WARNING — No flow detected after ${seconds}s. ` +
        `Press Emergency Stop to halt the pump.`,
        'warning'
    );
}

function hideSensorWarning() {
    const banner = document.getElementById('sensorWarningBanner');
    if (banner) banner.style.display = 'none';
    showStatus('Flow detected — sensor is active. Resuming normal monitoring.', 'info');
}

function clearSensorWarning() {
    const banner = document.getElementById('sensorWarningBanner');
    if (banner) banner.style.display = 'none';
}

// ============================================================
//  Controller Status Check
// ============================================================
function checkESP32Status() {
    fetch('/esp32/status', { cache: 'no-store' })
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

// ============================================================
//  History
// ============================================================
function updateHistory(page = 0) {
    fetch('/history')
        .then(r => r.json())
        .then(events => {
            const list = document.getElementById('historyList');
            list.innerHTML = '';
            if (!events.length) {
                list.innerHTML = '<li class="log-empty">No dispense records found.</li>';
                _set('pageInfo', 'Page 1');
                document.getElementById('prevHistory').disabled = true;
                document.getElementById('nextHistory').disabled = true;
                return;
            }
            currentHistoryPage = page;
            const start      = page * historyPerPage;
            const end        = start + historyPerPage;
            const totalPages = Math.ceil(events.length / historyPerPage);
            events.slice(start, end).forEach(event => {
                const li     = document.createElement('li');
                li.className = 'log-item ' + (event.type === 'DISPENSE' ? 'log-completed' : 'log-emergency');
                const tLabel = event.type === 'DISPENSE' ? 'COMPLETED' : 'EMERGENCY STOP';
                const tClass = event.type === 'DISPENSE' ? 'type-completed' : 'type-emergency';
                const delBtn = currentUserRole === 'admin'
                    ? `<button class="log-delete-btn" onclick="deleteHistory(${event.id})">✕</button>`
                    : '';
                li.innerHTML = `
                    <div class="log-item-content">
                        <div class="log-type ${tClass}">${tLabel}</div>
                        <div class="log-message">${event.message}</div>
                        <div class="log-meta">
                            <span class="log-operator">👤 ${event.operator || 'unknown'}</span>
                            <span class="log-time">⏱ ${event.timestamp}</span>
                            ${event.end_time ? `<span class="log-time">→ ${event.end_time}</span>` : ''}
                        </div>
                    </div>${delBtn}`;
                list.appendChild(li);
            });
            _set('pageInfo', `Page ${page + 1} / ${totalPages}`);
            document.getElementById('prevHistory').disabled = (currentHistoryPage === 0);
            document.getElementById('nextHistory').disabled = (end >= events.length);
        })
        .catch(() => {
            document.getElementById('historyList').innerHTML =
                '<li class="log-empty">Failed to load records.</li>';
        });
}

function prevHistory() { if (currentHistoryPage > 0) updateHistory(currentHistoryPage - 1); }
function nextHistory() { updateHistory(currentHistoryPage + 1); }

function deleteHistory(id) {
    if (!confirm('Delete this record?')) return;
    fetch(`/delete-history/${id}`, { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (d.status === 'success') { showStatus('Record deleted.', 'success'); updateHistory(currentHistoryPage); }
            else showStatus(d.message, 'danger');
        })
        .catch(err => showStatus(err.message, 'danger'));
}

function clearHistory() {
    if (!confirm('Clear all dispense log records?')) return;
    fetch('/clear-history', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
            if (d.status === 'success') { showStatus('Dispense log cleared.', 'success'); updateHistory(0); }
            else showStatus(d.message, 'danger');
        })
        .catch(err => showStatus(err.message, 'danger'));
}

function exportCSV() {
    fetch('/history')
        .then(r => r.json())
        .then(events => {
            if (!events.length) { showStatus('No records to export.', 'info'); return; }
            const rows = events.map(e =>
                [e.id, `"${e.timestamp}"`, e.type, `"${e.message.replace(/"/g,'""')}"`].join(',')
            );
            const csv  = ['ID,Timestamp,Type,Message', ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url  = URL.createObjectURL(blob);
            const a    = Object.assign(document.createElement('a'),
                { href: url, download: `dispense_log_${new Date().toISOString().slice(0,10)}.csv` });
            a.click();
            URL.revokeObjectURL(url);
            showStatus('Log exported as CSV.', 'success');
        })
        .catch(() => showStatus('Failed to export log.', 'danger'));
}

// ============================================================
//  User Management
// ============================================================
function openUserModal() {
    loadUsers();
    new bootstrap.Modal(document.getElementById('userModal')).show();
}

function loadUsers() {
    fetch('/users')
        .then(r => r.json())
        .then(users => {
            const selfName = document.getElementById('operatorName')?.textContent?.trim() || '';
            const tbody    = document.getElementById('userTableBody');
            tbody.innerHTML = '';
            users.forEach(u => {
                const isSelf = u.username === selfName;
                tbody.innerHTML += `<tr>
                    <td>${u.id}</td>
                    <td><strong>${u.username}</strong></td>
                    <td><span class="nav-role-pill role-${u.role}">${u.role.toUpperCase()}</span></td>
                    <td>${u.created_at || '—'}</td>
                    <td>${!isSelf
                        ? `<button class="btn btn-sm btn-outline-danger" onclick="removeUser(${u.id},'${u.username}')">✕ Remove</button>`
                        : '<span style="font-size:0.75rem;color:var(--text-3)">(you)</span>'
                    }</td></tr>`;
            });
        })
        .catch(() => {
            document.getElementById('userTableBody').innerHTML =
                '<tr><td colspan="5" class="text-center text-muted">Failed to load users.</td></tr>';
        });
}

function addUser() {
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const role     = document.getElementById('newRole').value;
    if (!username || !password) { showUserMsg('Username and password are required.', 'danger'); return; }
    fetch('/users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password,role}) })
        .then(r => r.json())
        .then(d => {
            if (d.status === 'success') {
                showUserMsg(d.message, 'success');
                document.getElementById('newUsername').value = '';
                document.getElementById('newPassword').value = '';
                loadUsers();
            } else showUserMsg(d.message, 'danger');
        })
        .catch(() => showUserMsg('Request failed.', 'danger'));
}

function removeUser(id, username) {
    if (!confirm(`Remove user "${username}"?`)) return;
    fetch(`/users/${id}`, { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (d.status === 'success') { showUserMsg(`User "${username}" removed.`, 'success'); loadUsers(); }
            else showUserMsg(d.message, 'danger');
        })
        .catch(() => showUserMsg('Request failed.', 'danger'));
}

function showUserMsg(msg, type) {
    const el = document.getElementById('userFormMsg');
    if (!el) return;
    el.innerHTML = `<span class="user-msg user-msg-${type}">${msg}</span>`;
    setTimeout(() => el.innerHTML = '', 4000);
}

// ============================================================
//  Change Password
// ============================================================
function openChangePasswordModal() {
    ['currentPassword','newPasswordChange','confirmNewPassword'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    const msg = document.getElementById('changePasswordMsg');
    if (msg) msg.innerHTML = '';
    new bootstrap.Modal(document.getElementById('changePasswordModal')).show();
}

function submitChangePassword() {
    const current = document.getElementById('currentPassword').value;
    const newPwd  = document.getElementById('newPasswordChange').value;
    const confirm = document.getElementById('confirmNewPassword').value;
    if (!current || !newPwd || !confirm) { showCPMsg('All fields are required.', 'danger'); return; }
    if (newPwd !== confirm) { showCPMsg('New passwords do not match.', 'danger'); return; }
    if (newPwd.length < 6) { showCPMsg('Password must be at least 6 characters.', 'danger'); return; }
    fetch('/change-password', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ current_password: current, new_password: newPwd }) })
        .then(r => r.json())
        .then(d => {
            if (d.status === 'success') {
                showCPMsg('Password updated. Signing you out…', 'success');
                setTimeout(() => {
                    fetch('/logout', { method: 'POST' }).finally(() => { window.location.href = '/login'; });
                }, 1800);
            } else showCPMsg(d.message, 'danger');
        })
        .catch(() => showCPMsg('Request failed.', 'danger'));
}

function showCPMsg(msg, type) {
    const el = document.getElementById('changePasswordMsg');
    if (el) el.innerHTML = `<span class="user-msg user-msg-${type}">${msg}</span>`;
}

// ============================================================
//  User Dropdown
// ============================================================
function toggleUserDropdown() {
    document.getElementById('userDropdownWrap')?.classList.toggle('open');
}
function closeUserDropdown() {
    document.getElementById('userDropdownWrap')?.classList.remove('open');
}
document.addEventListener('click', e => {
    const wrap = document.getElementById('userDropdownWrap');
    if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
});

// ============================================================
//  DOMContentLoaded
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    bindSlider('waterSlider', 'waterValue');
    bindSlider('syrupSlider', 'syrupValue');
    updateSummary();
    resetMonitor();
    checkESP32Status();
    fetch('/session-info')
        .then(r => r.json())
        .then(d => applyRoleUI(d.role))
        .catch(() => showSessionExpired());
});