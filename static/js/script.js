 // --- Global Variables ---
        let flowChart = null;
        let dispensing = false;
        let progressInterval = null;

        // --- Slider Binding Helper ---
        function bindSlider(sliderId, valueId, tooltipId) {
            const slider = document.getElementById(sliderId);
            const valueBox = document.getElementById(valueId);

            slider.addEventListener('input', () => {
                valueBox.textContent = slider.value;
                updateTooltip(sliderId, tooltipId);
            });
}

        // --- Initialize ---
       document.addEventListener('DOMContentLoaded', () => {
    bindSlider('waterSlider', 'waterValue', 'waterTooltip');
    bindSlider('syrupSlider', 'syrupValue', 'syrupTooltip');

    // Initialize tooltips once
    updateTooltip('waterSlider', 'waterTooltip');
    updateTooltip('syrupSlider', 'syrupTooltip');

    // Initialize chart & history
    initChart();
    updateHistory();
});


        // --- Functions ---
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

function startDispensing() {
    if (dispensing) return;

    const water = Number(document.getElementById('waterSlider').value);
    const syrup = Number(document.getElementById('syrupSlider').value);

    dispensing = true;

    const btn = document.querySelector('.btn-success');
    btn.disabled = true;
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
    }).catch(() => {
        emergencyStop();
    });
}

function emergencyStop() {
    if (!dispensing) return;

    clearInterval(progressInterval);
    dispensing = false;

    fetch('/stop', { method: 'POST' });

    document.querySelector('.btn-success').disabled = false;
    document.getElementById('dispenseBtnText').textContent = '🚀 Start Dispensing';
    document.getElementById('progressContainer').style.display = 'none';

    showStatus('Emergency stop activated! Pumps halted.', 'danger');
}

function finishDispense() {
    dispensing = false;

    document.querySelector('.btn-success').disabled = false;
    document.getElementById('dispenseBtnText').textContent = '🚀 Start Dispensing';

    showStatus('Dispensing completed successfully!', 'success');
    updateHistory();
}


        function showStatus(message, type = 'info') {
            const statusBox = document.getElementById('statusBox');
            statusBox.innerHTML = `<strong>${type.toUpperCase()}:</strong> ${message}`;
            statusBox.className = `alert alert-${type}`;
        }

       function initChart() {
    const ctx = document.getElementById('flowChart').getContext('2d');

    flowChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Flow Rate (ml/s)',
                data: [],
                borderWidth: 2,
                tension: 0.3
            }]
        },
        options: {
            animation: false,
            scales: {
                x: { title: { display: true, text: 'Time (s)' } },
                y: { title: { display: true, text: 'Flow Rate' }, min: 0 }
            }
        }
    });
}


        let timeStep = 0;

function updateChart(progress) {
    if (!flowChart) return;

    const flowRate = Math.max(0, 50 - progress * 0.4); // PID-like decay

    flowChart.data.labels.push(timeStep++);
    flowChart.data.datasets[0].data.push(flowRate);

    if (flowChart.data.labels.length > 20) {
        flowChart.data.labels.shift();
        flowChart.data.datasets[0].data.shift();
    }

    flowChart.update();
}


        function updateHistory() {
            fetch('/history')
                .then(response => response.json())
                .then(data => {
                    const list = document.getElementById('historyList');
                    list.innerHTML = '';
                    if (data.length === 0) {
                        list.innerHTML = '<li class="list-group-item">No dispenses yet</li>';
                        return;
                    }
                    data.slice(-5).reverse().forEach(item => {
                        const li = document.createElement('li');
                        li.className = 'list-group-item';
                        li.textContent = `Water: ${item.water}ml | Syrup: ${item.syrup}ml`;
                        list.appendChild(li);
                    });
                });
        }