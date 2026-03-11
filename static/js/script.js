// ============================================================
//  Global Variables
// ============================================================
let flowChart        = null;
let dispensing       = false;
let progressInterval = null;
let currentHistoryPage = 0;
const historyPerPage   = 3;
let timeStep           = 0;
let currentPump        = 0;
let currentUserRole    = null;   // set on DOMContentLoaded from session-info

// Custom reagent names (in-memory, reset on page reload)
let reagentNames = { A: 'Reagent A', B: 'Reagent B' };

// Chart colors per pump
const PUMP_COLORS = {
    1: { border: '#1a73e8', bg: 'rgba(26,115,232,0.08)' },
    2: { border: '#0f9d8a', bg: 'rgba(15,157,138,0.08)' }
};

// ============================================================
//  Auth — Logout & Session Expired
// ============================================================
function doLogout() {
    if (!confirm("Sign out of the system?")) return;
    fetch('/logout', { method: 'POST' })
        .then(() => window.location.href = '/login')
        .catch(() => window.location.href = '/login');
}

function showSessionExpired() {
    document.getElementById('sessionExpiredOverlay').style.display = 'flex';
}

// Global fetch interceptor — catches 401 on any API call
const _origFetch = window.fetch;
window.fetch = function(...args) {
    return _origFetch(...args).then(res => {
        if (res.status === 401) {
            showSessionExpired();
        }
        return res;
    });
};

// ============================================================
//  Role-Based UI
// ============================================================
function applyRoleUI(role) {
    currentUserRole = role;
    // Hide admin-only elements for operators
    if (role !== 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    }
}

// ============================================================
//  User Management (Admin only)
// ============================================================
function openUserModal() {
    loadUsers();
    new bootstrap.Modal(document.getElementById('userModal')).show();
}

function loadUsers() {
    fetch('/users')
        .then(res => res.json())
        .then(users => {
            const tbody = document.getElementById('userTableBody');
            tbody.innerHTML = '';
            users.forEach(u => {
                const isSelf = u.username === document.getElementById('operatorName').textContent;
                tbody.innerHTML += `
                    <tr>
                        <td>${u.id}</td>
                        <td><strong>${u.username}</strong></td>
                        <td><span class="role-badge role-${u.role}">${u.role.toUpperCase()}</span></td>
                        <td>${u.created_at || '—'}</td>
                        <td>
                            ${!isSelf ? `<button class="btn btn-sm btn-outline-danger" onclick="removeUser(${u.id}, '${u.username}')">✕ Remove</button>` : '<span class="text-muted" style="font-size:0.75rem">(you)</span>'}
                        </td>
                    </tr>`;
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
    const msgEl    = document.getElementById('userFormMsg');

    if (!username || !password) {
        showUserMsg('Username and password are required.', 'danger');
        return;
    }

    fetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            showUserMsg(data.message, 'success');
            document.getElementById('newUsername').value = '';
            document.getElementById('newPassword').value = '';
            loadUsers();
        } else {
            showUserMsg(data.message, 'danger');
        }
    })
    .catch(() => showUserMsg('Request failed.', 'danger'));
}

function removeUser(id, username) {
    if (!confirm(`Remove user "${username}"? This cannot be undone.`)) return;
    fetch(`/users/${id}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                showUserMsg(`User "${username}" removed.`, 'success');
                loadUsers();
            } else {
                showUserMsg(data.message, 'danger');
            }
        })
        .catch(() => showUserMsg('Request failed.', 'danger'));
}

function showUserMsg(msg, type) {
    const el = document.getElementById('userFormMsg');
    el.innerHTML = `<span class="user-msg user-msg-${type}">${msg}</span>`;
    setTimeout(() => el.innerHTML = '', 4000);
}

// ============================================================
//  Dark Mode
// ============================================================
function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('darkModeIcon').textContent = isDark ? '🌙 Dark Mode' : '☀ Light Mode';
}

// ============================================================
//  Reagent Rename
// ============================================================
let renamingReagent = null;

function openRenameModal(reagent) {
    renamingReagent = reagent;
    document.getElementById('renameModalTitle').textContent = `Rename Reagent ${reagent}`;
    document.getElementById('renameInput').value = reagentNames[reagent];
    new bootstrap.Modal(document.getElementById('renameModal')).show();
}

function applyRename() {
    const val = document.getElementById('renameInput').value.trim();
    if (!val) return;

    reagentNames[renamingReagent] = val;

    if (renamingReagent === 'A') {
        document.getElementById('labelReagentA').textContent    = val;
        document.getElementById('summaryLabelA').textContent    = val;
        document.getElementById('pump1ReagentLabel').textContent = val;
        document.getElementById('seqLabel1').textContent        = val;
    } else {
        document.getElementById('labelReagentB').textContent    = val;
        document.getElementById('summaryLabelB').textContent    = val;
        document.getElementById('pump2ReagentLabel').textContent = val;
        document.getElementById('seqLabel2').textContent        = val;
    }

    updateSummary();
    bootstrap.Modal.getInstance(document.getElementById('renameModal')).hide();
    showStatus(`Reagent ${renamingReagent} renamed to "${val}".`, 'info');
}

// ============================================================
//  Volume & Ratio Summary
// ============================================================
function updateSummary() {
    const a = Number(document.getElementById('waterSlider').value);
    const b = Number(document.getElementById('syrupSlider').value);

    document.getElementById('summaryVolA').textContent  = `${a} ml`;
    document.getElementById('summaryVolB').textContent  = `${b} ml`;
    document.getElementById('summaryTotal').textContent = `${a + b} ml`;

    let ratio = '—';
    if (a > 0 && b > 0) {
        const gcd = (x, y) => y === 0 ? x : gcd(y, x % y);
        const g = gcd(a, b);
        ratio = `${a / g}:${b / g}`;
    } else if (a > 0) {
        ratio = 'A only';
    } else if (b > 0) {
        ratio = 'B only';
    }
    document.getElementById('summaryRatio').textContent = ratio;

    // Also update timeline volumes
    document.getElementById('seqVol1').textContent = a > 0 ? `${a} ml` : 'SKIP';
    document.getElementById('seqVol2').textContent = b > 0 ? `${b} ml` : 'SKIP';

    // Hide pause block if only one pump runs
    const pauseEl = document.getElementById('seqPause');
    pauseEl.classList.toggle('hidden', !(a > 0 && b > 0));
}

// ============================================================
//  Sequence Timeline State
// ============================================================
function setTimelineState(block, state) {
    // state: 'idle' | 'active' | 'done' | 'skipped'
    const el = document.getElementById(`seqBlock${block}`);
    el.classList.remove('active', 'done', 'skipped');
    if (state !== 'idle') el.classList.add(state);
}

function resetTimeline() {
    setTimelineState(1, 'idle');
    setTimelineState(2, 'idle');
}

// ============================================================
//  Pump State Helper
// ============================================================
function setPumpState(pump, state) {
    const dot   = document.getElementById(`pump${pump}Dot`);
    const label = document.getElementById(`pump${pump}State`);
    dot.className   = `pump-dot ${state === 'idle' ? '' : state}`;
    label.className = `pump-state ${state === 'idle' ? '' : state}`;
    const stateText = { idle: 'IDLE', active: 'RUNNING', done: 'DONE', skipped: 'SKIPPED', stopped: 'STOPPED' };
    label.textContent = stateText[state] || 'IDLE';
}

function resetPumpStates() {
    setPumpState(1, 'idle');
    setPumpState(2, 'idle');
}

// ============================================================
//  Progress Bar Helpers
// ============================================================
function setProgressLabel(text) {
    const el = document.getElementById('progressStageLabel');
    if (el) el.textContent = text;
}

function setProgressPct(pct) {
    const bar      = document.getElementById('progressBar');
    const pctLabel = document.getElementById('progressPct');
    bar.style.width = pct + '%';
    if (pctLabel) pctLabel.textContent = pct + '%';
}

function resetProgressBar(color = '') {
    setProgressPct(0);
    setProgressLabel('');
    const bar = document.getElementById('progressBar');
    bar.style.backgroundColor = color || '';
    document.getElementById('progressContainer').style.display = 'none';
}

function showProgressBar() {
    document.getElementById('progressContainer').style.display = 'block';
}

// ============================================================
//  Slider Helpers
// ============================================================
function bindSlider(sliderId, valueId, tooltipId) {
    const slider  = document.getElementById(sliderId);
    const valueBox = document.getElementById(valueId);
    slider.addEventListener('input', () => {
        valueBox.textContent = slider.value;
        updateTooltip(sliderId, tooltipId);
        updateSummary();
    });
}

function updateTooltip(sliderId, tooltipId) {
    const slider  = document.getElementById(sliderId);
    const tooltip = document.getElementById(tooltipId);
    const percent = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    tooltip.textContent = slider.value + ' ml';
    tooltip.style.left  = percent + '%';
}

function setPreset(a, b) {
    document.getElementById('waterSlider').value = a;
    document.getElementById('syrupSlider').value = b;
    document.getElementById('waterValue').textContent = a;
    document.getElementById('syrupValue').textContent = b;
    updateTooltip('waterSlider', 'waterTooltip');
    updateTooltip('syrupSlider', 'syrupTooltip');
    updateSummary();
    showStatus(`Protocol loaded: ${reagentNames.A} ${a} ml | ${reagentNames.B} ${b} ml`, 'info');
}

// ============================================================
//  Confirmation Modal
// ============================================================
function showConfirmModal(reagentA, reagentB, onConfirm) {
    document.getElementById('confirmLabelA').textContent  = reagentNames.A;
    document.getElementById('confirmLabelB').textContent  = reagentNames.B;
    document.getElementById('confirmVolA').textContent    = reagentA > 0 ? `${reagentA} ml` : 'SKIP';
    document.getElementById('confirmVolB').textContent    = reagentB > 0 ? `${reagentB} ml` : 'SKIP';
    document.getElementById('confirmTotal').textContent   = `${reagentA + reagentB} ml`;

    let ratio = '—';
    if (reagentA > 0 && reagentB > 0) {
        const gcd = (x, y) => y === 0 ? x : gcd(y, x % y);
        const g   = gcd(reagentA, reagentB);
        ratio = `${reagentA / g} : ${reagentB / g}`;
    } else {
        ratio = reagentA > 0 ? 'A only' : 'B only';
    }
    document.getElementById('confirmRatio').textContent = ratio;

    let seq = '';
    if (reagentA > 0 && reagentB > 0) seq = 'Pump 1 → 2s pause → Pump 2';
    else if (reagentA > 0)             seq = 'Pump 1 only';
    else                               seq = 'Pump 2 only';
    document.getElementById('confirmSequence').textContent = seq;

    const modal = new bootstrap.Modal(document.getElementById('confirmModal'));
    modal.show();

    const btn = document.getElementById('confirmDispenseBtn');
    const newBtn = btn.cloneNode(true); // remove old listeners
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
        modal.hide();
        onConfirm();
    });
}

// ============================================================
//  Run a Single Pump Stage
// ============================================================
function runPumpStage(pumpNum, reagentLabel, volume, endpoint, params) {
    return new Promise((resolve, reject) => {
        currentPump = pumpNum;

        setPumpState(pumpNum, 'active');
        setTimelineState(pumpNum, 'active');
        setProgressLabel(`PUMP ${pumpNum} — ${reagentLabel} (${volume} ml)`);
        showProgressBar();
        setProgressPct(0);

        // Switch chart color for this pump
        if (flowChart) {
            flowChart.data.datasets[0].borderColor      = PUMP_COLORS[pumpNum].border;
            flowChart.data.datasets[0].backgroundColor  = PUMP_COLORS[pumpNum].bg;
            flowChart.data.datasets[0].label = `Pump ${pumpNum} — Flow Rate (ml/s)`;
            flowChart.data.labels = [];
            flowChart.data.datasets[0].data = [];
            flowChart.update();
            timeStep = 0;
        }

        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        })
        .then(async res => {
            if (!res.ok) { const e = await res.json(); throw new Error(e.message || 'Command rejected'); }
            return res.json();
        })
        .then(data => {
            if (data.status !== 'started') throw new Error(data.message || 'Failed to start pump');
            showStatus(`[PUMP ${pumpNum} ACTIVE] Dispensing ${reagentLabel}: ${volume} ml`, 'warning');

            let progress = 0;
            progressInterval = setInterval(() => {
                if (!dispensing) { clearInterval(progressInterval); return; }
                progress += 2;
                setProgressPct(Math.min(progress, 100));
                updateChart(progress);
                if (progress >= 100) {
                    clearInterval(progressInterval);
                    setPumpState(pumpNum, 'done');
                    setTimelineState(pumpNum, 'done');
                    resolve();
                }
            }, 200);
        })
        .catch(err => {
            setPumpState(pumpNum, 'stopped');
            setTimelineState(pumpNum, 'idle');
            reject(err);
        });
    });
}

// ============================================================
//  Main Dispense Sequence
// ============================================================
async function startDispensing() {
    const statusSpan = document.getElementById('connectionStatus');
    if (statusSpan.classList.contains('text-danger')) {
        showStatus("Cannot initiate: Controller is disconnected.", "danger");
        return;
    }
    if (dispensing) return;

    const reagentA = Number(document.getElementById('waterSlider').value);
    const reagentB = Number(document.getElementById('syrupSlider').value);

    if (reagentA === 0 && reagentB === 0) {
        showStatus("[ALERT] Both reagent volumes are zero. Set at least one volume before dispensing.", "danger");
        return;
    }

    // Show confirmation modal first — only proceed on confirm
    showConfirmModal(reagentA, reagentB, () => executeDispense(reagentA, reagentB));
}

async function executeDispense(reagentA, reagentB) {
    dispensing = true;
    resetPumpStates();
    resetTimeline();
    document.querySelector('.btn-success').disabled = true;
    document.getElementById('dispenseBtnText').textContent = '⏳ Dispensing...';

    if (flowChart) {
        flowChart.data.labels = [];
        flowChart.data.datasets[0].data = [];
        flowChart.update();
        timeStep = 0;
    }

    try {
        // ── PUMP 1 — Reagent A ──
        if (reagentA === 0) {
            setPumpState(1, 'skipped');
            setTimelineState(1, 'skipped');
            showStatus(`[PUMP 1 SKIPPED] ${reagentNames.A} = 0 ml. Proceeding to Pump 2.`, "info");
        } else {
            await runPumpStage(1, reagentNames.A, reagentA, '/dispense', { reagent_a: reagentA, reagent_b: 0 });

            if (reagentB > 0) {
                showStatus("[PAUSE] Pump 1 complete. Switching to Pump 2 in 2 seconds...", "info");
                resetProgressBar();
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!dispensing) return;

        // ── PUMP 2 — Reagent B ──
        if (reagentB === 0) {
            setPumpState(2, 'skipped');
            setTimelineState(2, 'skipped');
            showStatus(`[PUMP 2 SKIPPED] ${reagentNames.B} = 0 ml.`, "info");
        } else {
            await runPumpStage(2, reagentNames.B, reagentB, '/dispense', { reagent_a: 0, reagent_b: reagentB });
        }

        await finishDispense(reagentA, reagentB);

    } catch (error) {
        console.error(error);
        showStatus(error.message, 'danger');
        resetDispenseUI();
    }
}

// ============================================================
//  Emergency Stop
// ============================================================
function emergencyStop() {
    if (!dispensing) return;

    clearInterval(progressInterval);
    dispensing = false;

    document.getElementById('progressBar').style.backgroundColor = '#c62828';
    setPumpState(1, 'stopped');
    setPumpState(2, 'stopped');
    showStatus('[EMERGENCY STOP] All pumps halted. Inspect system before resuming.', 'danger');

    fetch('/emergency-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: "Operator triggered emergency stop" })
    }).then(() => updateHistory());

    resetDispenseUI(true);
}

// ============================================================
//  Finish Dispense
// ============================================================
async function finishDispense(reagentA, reagentB) {
    try {
        await fetch('/complete', { method: 'POST' });
        showStatus(
            `[COMPLETE] Sequence finished. ${reagentNames.A}: ${reagentA} ml | ${reagentNames.B}: ${reagentB} ml`,
            'success'
        );
        updateHistory();
    } catch {
        showStatus('Error updating system status.', 'danger');
    }
    resetDispenseUI();
}

// ============================================================
//  Reset UI
// ============================================================
function resetDispenseUI(keepBar = false) {
    dispensing = false;
    document.querySelector('.btn-success').disabled = false;
    document.getElementById('dispenseBtnText').textContent = '▶ Initiate Dispense';
    if (!keepBar) resetProgressBar();
    if (flowChart) {
        flowChart.data.labels = [];
        flowChart.data.datasets[0].data = [];
        flowChart.update();
        timeStep = 0;
    }
}

// ============================================================
//  Chart
// ============================================================
function initChart() {
    const ctx = document.getElementById('flowChart').getContext('2d');
    flowChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Flow Rate (ml/s)',
                data: [],
                borderColor: PUMP_COLORS[1].border,
                backgroundColor: PUMP_COLORS[1].bg,
                borderWidth: 2,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            animation: false,
            plugins: { legend: { labels: { font: { family: 'IBM Plex Mono', size: 11 } } } },
            scales: {
                x: { title: { display: true, text: 'Time (s)',         font: { family: 'IBM Plex Mono', size: 11 } } },
                y: { title: { display: true, text: 'Flow Rate (ml/s)', font: { family: 'IBM Plex Mono', size: 11 } }, min: 0 }
            }
        }
    });
}

function updateChart(progress) {
    if (!flowChart) return;
    const flowRate = Math.max(0, 50 - progress * 0.4);
    flowChart.data.labels.push(timeStep++);
    flowChart.data.datasets[0].data.push(flowRate);
    if (flowChart.data.labels.length > 20) {
        flowChart.data.labels.shift();
        flowChart.data.datasets[0].data.shift();
    }
    flowChart.update();
}

// ============================================================
//  Status
// ============================================================
function showStatus(message, type = 'info') {
    const statusBox = document.getElementById('statusBox');
    statusBox.innerHTML = message;
    statusBox.className = `lab-status-box alert-${type}`;
}

// ============================================================
//  Export CSV
// ============================================================
function exportCSV() {
    fetch('/history')
        .then(res => res.json())
        .then(events => {
            if (events.length === 0) {
                showStatus("No records to export.", "info");
                return;
            }

            const headers = ['ID', 'Timestamp', 'Type', 'Message'];
            const rows = events.map(e => [
                e.id,
                `"${e.timestamp}"`,
                e.type,
                `"${e.message.replace(/"/g, '""')}"`
            ]);

            const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `dispense_log_${new Date().toISOString().slice(0,10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            showStatus("Dispense log exported as CSV.", "success");
        })
        .catch(() => showStatus("Failed to export log.", "danger"));
}

// ============================================================
//  History & Pagination
// ============================================================
function updateHistory(page = 0) {
    fetch('/history')
        .then(res => res.json())
        .then(events => {
            const list = document.getElementById('historyList');
            list.innerHTML = '';
            if (events.length === 0) {
                list.innerHTML = '<li class="list-group-item lab-log-empty">No dispense records found</li>';
                return;
            }

            events.reverse();
            currentHistoryPage = page;
            const start = page * historyPerPage;
            const end   = start + historyPerPage;

            events.slice(start, end).forEach(event => {
                const li = document.createElement('li');
                li.classList.add('list-group-item', 'd-flex', 'justify-content-between', 'align-items-start');

                const contentDiv = document.createElement('div');
                const operatorTag = `<span class="log-operator">👤 ${event.operator || 'unknown'}</span>`;

                if (event.type === 'DISPENSE') {
                    li.classList.add('list-group-item-success');
                    contentDiv.innerHTML = `<strong>[DISPENSE]</strong> ${operatorTag}<br>${event.message}<br><small class="text-muted">⏱ ${event.timestamp}</small>`;
                } else if (event.type === 'EMERGENCY') {
                    li.classList.add('list-group-item-danger');
                    contentDiv.innerHTML = `<strong>[EMERGENCY STOP]</strong> ${operatorTag}<br>${event.message}<br><small class="text-muted">⏱ ${event.timestamp}</small>`;
                } else {
                    contentDiv.innerHTML = event.message;
                }

                const deleteBtn = document.createElement('button');
                deleteBtn.className = "btn btn-sm btn-outline-danger";
                if (currentUserRole !== 'admin') deleteBtn.style.display = 'none';
                deleteBtn.innerHTML = "✕";
                deleteBtn.onclick   = () => deleteHistory(event.id);

                li.appendChild(contentDiv);
                li.appendChild(deleteBtn);
                list.appendChild(li);
            });

            document.getElementById('prevHistory').disabled = (currentHistoryPage === 0);
            document.getElementById('nextHistory').disabled = (end >= events.length);
        });
}

function prevHistory() { if (currentHistoryPage > 0) updateHistory(currentHistoryPage - 1); }
function nextHistory() { updateHistory(currentHistoryPage + 1); }

function deleteHistory(id) {
    if (!confirm("Delete this record?")) return;
    fetch(`/delete-history/${id}`, { method: 'DELETE' })
        .then(async res => {
            if (!res.ok) { const e = await res.json(); throw new Error(e.message || "Delete failed"); }
            return res.json();
        })
        .then(data => {
            if (data.status === "success") { showStatus("Record deleted.", "success"); updateHistory(currentHistoryPage); }
            else throw new Error(data.message);
        })
        .catch(err => { console.error(err); showStatus(err.message, "danger"); });
}

function clearHistory() {
    if (!confirm("Clear all dispense log records?")) return;
    fetch('/clear-history', { method: 'POST' })
        .then(async res => {
            if (!res.ok) { const e = await res.json(); throw new Error(e.message || "Failed to clear log"); }
            return res.json();
        })
        .then(data => {
            if (data.status === "success") { showStatus("Dispense log cleared.", "success"); updateHistory(0); }
            else throw new Error(data.message);
        })
        .catch(err => { console.error(err); showStatus(err.message, "danger"); });
}

// ============================================================
//  Initialize
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    bindSlider('waterSlider', 'waterValue', 'waterTooltip');
    bindSlider('syrupSlider', 'syrupValue', 'syrupTooltip');
    updateTooltip('waterSlider', 'waterTooltip');
    updateTooltip('syrupSlider', 'syrupTooltip');
    updateSummary();
    initChart();
    updateHistory();
    resetPumpStates();
    resetTimeline();

    // Fetch session info and apply role-based UI
    fetch('/session-info')
        .then(res => res.json())
        .then(data => applyRoleUI(data.role))
        .catch(() => showSessionExpired());
});

// ============================================================
//  Controller Status Check
// ============================================================
function updateESP32ButtonState() {
    const button     = document.querySelector('.btn-success');
    const statusSpan = document.getElementById('connectionStatus');
    button.disabled  = statusSpan.classList.contains('text-danger');
}

function checkESP32Status() {
    fetch('/esp32/status', { cache: 'no-store' })
        .then(res => res.json())
        .then(data => {
            const statusSpan = document.getElementById('connectionStatus');
            const connected  = data.status === "connected";
            statusSpan.textContent = connected ? '⬤ Controller Online' : '⬤ Controller Offline';
            statusSpan.className   = connected
                ? 'status-value text-success fw-bold'
                : 'status-value text-danger fw-bold';
            updateESP32ButtonState();
        })
        .catch(() => {
            const statusSpan = document.getElementById('connectionStatus');
            statusSpan.textContent = '⬤ Controller Offline';
            statusSpan.className   = 'status-value text-danger fw-bold';
            updateESP32ButtonState();
        });
}

setInterval(checkESP32Status, 500);
document.addEventListener('DOMContentLoaded', checkESP32Status);