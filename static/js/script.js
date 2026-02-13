// --- Global Variables ---
let flowChart = null;
let dispensing = false;
let progressInterval = null;
let currentHistoryPage = 0;      // current page index
const historyPerPage = 3;        // logs per page
let timeStep = 0;

// --- Slider Helper ---
function bindSlider(sliderId, valueId, tooltipId) {
    const slider = document.getElementById(sliderId);
    const valueBox = document.getElementById(valueId);

    slider.addEventListener('input', () => {
        valueBox.textContent = slider.value;
        updateTooltip(sliderId, tooltipId);
    });
}

function updateTooltip(sliderId, tooltipId) {
    const slider = document.getElementById(sliderId);
    const tooltip = document.getElementById(tooltipId);
    const value = slider.value;
    const min = slider.min;
    const max = slider.max;
    const percent = ((value - min) / (max - min)) * 100;
    tooltip.textContent = value + ' ml';
    tooltip.style.left = percent + '%';
}

function setPreset(water, syrup) {
    document.getElementById('waterSlider').value = water;
    document.getElementById('syrupSlider').value = syrup;
    document.getElementById('waterValue').textContent = water;
    document.getElementById('syrupValue').textContent = syrup;
    updateTooltip('waterSlider', 'waterTooltip');
    updateTooltip('syrupSlider', 'syrupTooltip');
    showStatus(`Preset loaded: ${water}ml Water, ${syrup}ml Syrup`, 'info');
}

// --- Dispensing Functions ---
function startDispensing() {
    if (dispensing) return;

    const water = Number(document.getElementById('waterSlider').value);
    const syrup = Number(document.getElementById('syrupSlider').value);

    dispensing = true;
    document.querySelector('.btn-success').disabled = true;
    document.getElementById('dispenseBtnText').textContent = '⏳ Dispensing...';
    showStatus(`Dispensing ${water} ml Water & ${syrup} ml Syrup`, 'warning');

    const progressBar = document.getElementById('progressBar');
    document.getElementById('progressContainer').style.display = 'block';

    let progress = 0;
    progressInterval = setInterval(() => {
        progress += 2;
        progressBar.style.width = progress + '%';
        progressBar.textContent = progress + '%';
        updateChart(progress);

        if (progress >= 100) {
            clearInterval(progressInterval);
            finishDispense();
        }
    }, 200);

    fetch('/dispense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ water, syrup })
    }).catch(() => emergencyStop());
}

function emergencyStop() {
    if (!dispensing) return;

    clearInterval(progressInterval);
    dispensing = false;

    fetch('/emergency-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: "User pressed emergency stop" })
    }).then(() => updateHistory());

    document.querySelector('.btn-success').disabled = false;
    document.getElementById('dispenseBtnText').textContent = '🚀 Start Dispensing';
    document.getElementById('progressContainer').style.display = 'none';

    showStatus('Emergency stop activated! Pumps halted.', 'danger');
}

function finishDispense() {
    dispensing = false;
    document.querySelector('.btn-success').disabled = false;
    document.getElementById('dispenseBtnText').textContent = '🚀 Start Dispensing';

    fetch('/complete', { method: 'POST' })
        .then(() => {
            showStatus('Dispensing completed successfully!', 'success');
            updateHistory();
        })
        .catch(() => showStatus('Error updating status!', 'danger'));
}

// --- Chart Functions ---
function initChart() {
    const ctx = document.getElementById('flowChart').getContext('2d');
    flowChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Flow Rate (ml/s)', data: [], borderWidth: 2, tension: 0.3 }] },
        options: { animation: false, scales: { x: { title: { display: true, text: 'Time (s)' } }, y: { title: { display: true, text: 'Flow Rate' }, min: 0 } } }
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

// --- Status ---
function showStatus(message, type = 'info') {
    const statusBox = document.getElementById('statusBox');
    statusBox.innerHTML = `<strong>${type.toUpperCase()}:</strong> ${message}`;
    statusBox.className = `alert alert-${type}`;
}

// --- History & Pagination ---
function updateHistory(page = 0) {
    fetch('/history')
        .then(res => res.json())
        .then(events => {
            const list = document.getElementById('historyList');
            list.innerHTML = '';
            if (events.length === 0) {
                list.innerHTML = '<li class="list-group-item">No activity yet</li>';
                return;
            }

            events.reverse(); // latest first
            currentHistoryPage = page;

            const start = page * historyPerPage;
            const end = start + historyPerPage;
            const pageEvents = events.slice(start, end);

            pageEvents.forEach(event => {
                const li = document.createElement('li');
                li.classList.add('list-group-item');

                if (event.type === 'DISPENSE') {
                    li.classList.add('list-group-item-success');
                    li.innerHTML = `🟢 <strong>DISPENSE</strong><br>${event.message}<br><small>⏱ ${event.timestamp}</small>`;
                } else if (event.type === 'EMERGENCY') {
                    li.classList.add('list-group-item-danger');
                    li.innerHTML = `🔴 <strong>EMERGENCY STOP</strong><br>${event.message}<br><small>⏱ ${event.timestamp}</small>`;
                } else {
                    li.innerHTML = event.message;
                }

                list.appendChild(li);
            });

            document.getElementById('prevHistory').disabled = (currentHistoryPage === 0);
            document.getElementById('nextHistory').disabled = (end >= events.length);
        });
}

function prevHistory() {
    if (currentHistoryPage > 0) updateHistory(currentHistoryPage - 1);
}
function nextHistory() {
    updateHistory(currentHistoryPage + 1);
}

// --- Initialize Sliders, Chart, History ---
document.addEventListener('DOMContentLoaded', () => {
    bindSlider('waterSlider', 'waterValue', 'waterTooltip');
    bindSlider('syrupSlider', 'syrupValue', 'syrupTooltip');
    updateTooltip('waterSlider', 'waterTooltip');
    updateTooltip('syrupSlider', 'syrupTooltip');
    initChart();
    updateHistory();
});

function checkESP32Status() {
    fetch('/esp32/status')
        .then(res => res.json())
        .then(data => {
            const statusSpan = document.getElementById('connectionStatus');
            if (data.connected) {
                statusSpan.textContent = '🟢 ESP32 Connected';
                statusSpan.className = 'text-success fw-bold';
            } else {
                statusSpan.textContent = '🔴 ESP32 Disconnected';
                statusSpan.className = 'text-danger fw-bold';
            }
        })
        .catch(() => {
            document.getElementById('connectionStatus').textContent = '🔴 ESP32 Disconnected';
        });
}

// Poll every 2 seconds
setInterval(checkESP32Status, 500);
document.addEventListener('DOMContentLoaded', checkESP32Status);