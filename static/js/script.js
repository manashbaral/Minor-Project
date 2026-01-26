 // --- Global Variables ---
        let flowChart = null;

        // --- Initialize ---
        document.addEventListener('DOMContentLoaded', function() {
            // Update slider values in real-time
            document.getElementById('waterSlider').addEventListener('input', function() {
                document.getElementById('waterValue').textContent = this.value;
                updateTooltip('waterSlider', 'waterTooltip');
            });
            document.getElementById('syrupSlider').addEventListener('input', function() {
                document.getElementById('syrupValue').textContent = this.value;
                updateTooltip('syrupSlider', 'syrupTooltip');
            });

            // Initialize tooltips
            updateTooltip('waterSlider', 'waterTooltip');
            updateTooltip('syrupSlider', 'syrupTooltip');

            // Initialize chart
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
            const water = document.getElementById('waterSlider').value;
            const syrup = document.getElementById('syrupSlider').value;

            // Disable button and show progress
            const btn = document.querySelector('button.btn-success');
            btn.disabled = true;
            document.getElementById('dispenseBtnText').textContent = '⏳ Dispensing...';

            showStatus(`Starting: ${water}ml Water + ${syrup}ml Syrup`, 'warning');

            // Show progress bar
            const progressContainer = document.getElementById('progressContainer');
            const progressBar = document.getElementById('progressBar');
            progressContainer.style.display = 'block';
            progressBar.style.width = '0%';
            progressBar.textContent = '0%';

            // Simulate progress (replace with real WebSocket updates)
            let progress = 0;
            const interval = setInterval(() => {
                progress += 10;
                progressBar.style.width = progress + '%';
                progressBar.textContent = progress + '%';
                if (progress >= 100) {
                    clearInterval(interval);
                    progressBar.classList.remove('progress-bar-animated');
                }
            }, 300);

            // Send data to Flask backend
            fetch('/dispense', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ water: water, syrup: syrup })
            })
            .then(response => response.json())
            .then(data => {
                showStatus(data.message, 'success');
                updateChart(); // Update flow chart
                updateHistory(); // Refresh history

                // Re-enable button after 3 seconds
                setTimeout(() => {
                    btn.disabled = false;
                    document.getElementById('dispenseBtnText').textContent = '🚀 Start Dispensing';
                    progressContainer.style.display = 'none';
                    progressBar.classList.add('progress-bar-animated');
                }, 3000);
            })
            .catch(error => {
                showStatus('Error: ' + error.message, 'danger');
                btn.disabled = false;
                document.getElementById('dispenseBtnText').textContent = '🚀 Start Dispensing';
            });
        }

        function emergencyStop() {
            fetch('/stop', { method: 'POST' }) // You'll need to create this route in Flask
                .then(() => {
                    showStatus('Emergency stop activated! All pumps halted.', 'danger');
                    document.querySelector('button.btn-success').disabled = false;
                    document.getElementById('progressContainer').style.display = 'none';
                });
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
                    labels: ['0s', '2s', '4s', '6s', '8s', '10s'],
                    datasets: [{
                        label: 'Water Flow Rate (ml/s)',
                        data: [0, 20, 45, 30, 50, 0],
                        borderColor: '#0d6efd',
                        backgroundColor: 'rgba(13, 110, 253, 0.1)',
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Real-time Flow Rate'
                        }
                    }
                }
            });
        }

        function updateChart() {
            // Simulate new data
            if (flowChart) {
                const newData = Math.random() * 50 + 10;
                flowChart.data.datasets[0].data.push(newData);
                if (flowChart.data.labels.length > 10) {
                    flowChart.data.labels.shift();
                    flowChart.data.datasets[0].data.shift();
                }
                flowChart.update();
            }
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