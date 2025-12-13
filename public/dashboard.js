// Initialize Chart
const chartContainer = document.getElementById('chart-container');
const chart = LightweightCharts.createChart(chartContainer, {
    layout: {
        background: { type: 'solid', color: '#1e1e1e' },
        textColor: '#d1d4dc',
    },
    grid: {
        vertLines: { color: '#333' },
        horzLines: { color: '#333' },
    },
    width: chartContainer.clientWidth,
    height: 400,
});

const candlestickSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
});

// Handle resize
window.addEventListener('resize', () => {
    chart.applyOptions({ width: chartContainer.clientWidth });
});

// Polling Functions
async function updateStatus() {
    try {
        // Check Angel One (Data)
        const angelRes = await fetch('/api/auth/angelone/status');
        const angelData = await angelRes.json();
        const angelEl = document.getElementById('angel-status');
        if (angelData.authenticated) {
            angelEl.textContent = 'CONNECTED';
            angelEl.className = 'status-value connected';
        } else {
            angelEl.textContent = 'DISCONNECTED';
            angelEl.className = 'status-value disconnected';
        }

        // Check Zerodha (Execution)
        const zerodhaRes = await fetch('/api/auth/zerodha/status');
        const zerodhaData = await zerodhaRes.json();
        const zerodhaEl = document.getElementById('zerodha-status');
        if (zerodhaData.authenticated) {
            zerodhaEl.textContent = 'CONNECTED';
            zerodhaEl.className = 'status-value connected';
        } else {
            zerodhaEl.textContent = 'DISCONNECTED';
            zerodhaEl.className = 'status-value disconnected';
        }

    } catch (error) {
        console.error('Failed to fetch status:', error);
    }
}

// System Health Monitoring
async function updateSystemHealth() {
    try {
        const res = await fetch('/api/admin/health', {
            headers: { 'X-Admin-API-Key': localStorage.getItem('adminApiKey') || '' }
        });

        if (!res.ok) {
            // No admin key or unauthorized - show basic status
            const dot = document.getElementById('health-dot');
            const status = document.getElementById('health-status');
            dot.className = 'health-dot pending';
            status.textContent = 'Auth Required';
            return;
        }

        const health = await res.json();

        const dot = document.getElementById('health-dot');
        const status = document.getElementById('health-status');
        const uptime = document.getElementById('health-uptime');

        // Update dot color
        dot.className = `health-dot ${health.status}`;

        // Update status text
        if (health.status === 'healthy') {
            status.textContent = 'All Systems OK';
            status.className = 'status-value connected';
        } else if (health.status === 'degraded') {
            const degradedComponents = health.components
                .filter(c => c.status !== 'healthy')
                .map(c => c.name)
                .join(', ');
            status.textContent = `Degraded: ${degradedComponents}`;
            status.className = 'status-value pending';
        } else {
            status.textContent = 'Unhealthy';
            status.className = 'status-value disconnected';
        }

        // Update uptime
        if (health.uptime) {
            const hours = Math.floor(health.uptime / 3600);
            const mins = Math.floor((health.uptime % 3600) / 60);
            uptime.textContent = `Uptime: ${hours}h ${mins}m | Mem: ${health.memory.percentUsed}%`;
        }
    } catch (error) {
        console.error('Failed to fetch system health:', error);
    }
}

async function updateStrategies() {
    try {
        const res = await fetch('/api/strategies');
        const data = await res.json();
        const list = document.getElementById('strategies-list');

        list.innerHTML = data.data.map(s => `
            <div class="strategy-card">
                <h3>${s.name}</h3>
                <p>${s.description}</p>
                <small>ID: ${s.id}</small>
            </div>
        `).join('');
    } catch (error) {
        console.error('Failed to fetch strategies:', error);
    }
}

async function updateMarketData() {
    try {
        // Ideally this should be a WebSocket, but for now we poll the snapshot
        // Note: The current API returns a snapshot, but we need history for candles.
        // For this demo, we'll just plot the current tick as a candle update if available.
        const res = await fetch('/api/market-data');
        const data = await res.json();

        // Mock data for demonstration if empty
        // In a real app, we'd fetch historical candles first
        if (data.data && data.data.ticks.length > 0) {
            const tick = data.data.ticks[0]; // Just taking first symbol for now

            // Update chart (mocking open/high/low from last price for demo)
            // Real implementation needs OHLCV aggregation on backend
            const time = Math.floor(new Date(tick.timestamp).getTime() / 1000);
            candlestickSeries.update({
                time: time,
                open: tick.price,
                high: tick.price,
                low: tick.price,
                close: tick.price,
            });
        }
    } catch (error) {
        console.error('Failed to fetch market data:', error);
    }
}

async function updateReconciliationStatus() {
    try {
        const res = await fetch('/api/reconciliation/status');
        const data = await res.json();

        const statusEl = document.getElementById('recon-status');
        const sectionEl = document.getElementById('recon-section');
        const listEl = document.getElementById('recon-list');

        if (data.hasDiscrepancies) {
            statusEl.textContent = 'DISCREPANCY';
            statusEl.className = 'status-value disconnected'; // Reuse disconnected style for error
            sectionEl.classList.remove('hidden');

            listEl.innerHTML = data.discrepancies.map(d => `
                <div class="recon-item">
                    <span class="symbol">${d.symbol}</span>
                    <div class="recon-details">
                        <span>Local: ${d.localQuantity}</span>
                        <span>Broker: ${d.brokerQuantity}</span>
                        <span>Diff: ${d.difference}</span>
                    </div>
                    <div class="actions">
                        <span class="recon-action">${d.action}</span>
                        <button class="btn btn-warning btn-sm" onclick="syncSymbol('${d.symbol}')">Sync</button>
                    </div>
                </div>
            `).join('');

        } else {
            statusEl.textContent = 'SYNCED';
            statusEl.className = 'status-value connected';
            sectionEl.classList.add('hidden');
        }
    } catch (error) {
        console.error('Failed to fetch reconciliation status:', error);
    }
}

// Global function for the sync button in the list
window.syncSymbol = async (symbol) => {
    try {
        await fetch(`/api/reconciliation/sync/${symbol}`, { method: 'POST' });
        await updateReconciliationStatus();
    } catch (_err) {
        alert('Failed to sync ' + symbol);
    }
};

const reconSyncBtn = document.getElementById('recon-sync-btn');
if (reconSyncBtn) {
    reconSyncBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/reconciliation/run', { method: 'POST' });
            await updateReconciliationStatus();
            alert('Reconciliation run triggered');
        } catch (_err) {
            alert('Failed to trigger reconciliation');
        }
    });
}

// Start Polling
setInterval(updateStatus, 5000);
setInterval(updateStrategies, 10000);
setInterval(updateMarketData, 1000); // Aggressive polling for demo
setInterval(updateMarketData, 1000); // Aggressive polling for demo
setInterval(updateLoopStatus, 2000); // Poll loop status
setInterval(updateReconciliationStatus, 5000); // Poll reconciliation
setInterval(updateDailyPnL, 2000); // Poll P&L
setInterval(updateSystemHealth, 5000); // Poll system health

// Initial call
updateStatus();
updateStrategies();
updateMarketData();
updateLoopStatus();
updateReconciliationStatus();
updateDailyPnL();
updateSystemHealth();

// P&L Functions
async function updateDailyPnL() {
    try {
        const [pnlRes, stopLossRes] = await Promise.all([
            fetch('/api/pnl/positions'),
            fetch('/api/stop-loss')
        ]);

        const pnlData = await pnlRes.json();
        const stopLossData = await stopLossRes.json();

        // Build stop-loss lookup
        const stopLosses = new Map();
        if (stopLossData.success && stopLossData.data.stopLosses) {
            stopLossData.data.stopLosses.forEach(sl => {
                stopLosses.set(sl.symbol, sl);
            });
        }

        // Fetch daily summary for realized P&L
        const dailyRes = await fetch('/api/pnl/daily');
        const dailyData = await dailyRes.json();

        if (dailyData.success) {
            const summary = dailyData.data.summary;

            // Update P&L cards
            updatePnLValue('realized-pnl', summary.realizedPnL);
            updatePnLValue('unrealized-pnl', summary.unrealizedPnL);
            updatePnLValue('total-pnl', summary.totalPnL);

            document.getElementById('trade-count').textContent = summary.tradeCount;
            document.getElementById('pnl-date').textContent = dailyData.data.date;
        }

        // Update positions table
        if (pnlData.success) {
            updatePositionsTable(pnlData.data.positions, stopLosses);
            document.getElementById('positions-count').textContent =
                `${pnlData.data.totals.positionCount} position${pnlData.data.totals.positionCount !== 1 ? 's' : ''}`;
        }
    } catch (error) {
        console.error('Failed to fetch P&L data:', error);
    }
}

function updatePnLValue(elementId, value) {
    const el = document.getElementById(elementId);
    const formatted = formatCurrency(value);
    el.textContent = formatted;

    el.classList.remove('profit', 'loss', 'neutral');
    if (value > 0) {
        el.classList.add('profit');
    } else if (value < 0) {
        el.classList.add('loss');
    } else {
        el.classList.add('neutral');
    }
}

function formatCurrency(value) {
    const prefix = value >= 0 ? '₹' : '-₹';
    return prefix + Math.abs(value).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function updatePositionsTable(positions, stopLosses) {
    const tbody = document.getElementById('positions-tbody');

    if (!positions || positions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No open positions</td></tr>';
        return;
    }

    tbody.innerHTML = positions.map(pos => {
        const pnlClass = pos.unrealizedPnl > 0 ? 'profit' : pos.unrealizedPnl < 0 ? 'loss' : 'neutral';
        const pnlPercentClass = pos.unrealizedPnlPercent > 0 ? 'profit' : pos.unrealizedPnlPercent < 0 ? 'loss' : 'neutral';

        // Get stop-loss for this position
        const sl = stopLosses.get(pos.symbol);
        let stopLossHtml = '<span class="neutral">—</span>';

        if (sl) {
            const isTrailing = sl.type === 'TRAILING';
            const badgeClass = isTrailing ? 'stop-loss-badge trailing' : 'stop-loss-badge';
            stopLossHtml = `<span class="${badgeClass}">₹${sl.stopLossPrice.toFixed(2)}</span>`;
        }

        return `
            <tr>
                <td class="symbol">${pos.symbol}</td>
                <td>${pos.quantity}</td>
                <td>₹${pos.entryPrice.toFixed(2)}</td>
                <td>₹${pos.currentPrice.toFixed(2)}</td>
                <td class="${pnlClass}">${formatCurrency(pos.unrealizedPnl)}</td>
                <td class="${pnlPercentClass}">${pos.unrealizedPnlPercent >= 0 ? '+' : ''}${pos.unrealizedPnlPercent.toFixed(2)}%</td>
                <td>${stopLossHtml}</td>
            </tr>
        `;
    }).join('');
}

// Settings Logic
async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const settings = await res.json();

        document.getElementById('maxDailyLoss').value = settings.maxDailyLoss;
        document.getElementById('maxDailyLossPercent').value = settings.maxDailyLossPercent;
        document.getElementById('stopLossPercent').value = settings.stopLossPercent;
        document.getElementById('maxOpenPositions').value = settings.maxOpenPositions;
        document.getElementById('maxPositionSize').value = settings.maxPositionSize;
    } catch (error) {
        console.error('Failed to load settings:', error);
    }
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            alert('Settings saved successfully');
            loadSettings(); // Reload to confirm
        } else {
            const err = await res.json();
            alert('Failed to save settings: ' + err.message);
        }
    } catch (_error) {
        alert('Error saving settings');
    }
});

document.getElementById('reset-settings-btn').addEventListener('click', async () => {
    if (!confirm('Reset all risk settings to defaults?')) return;

    try {
        await fetch('/api/settings/reset', { method: 'POST' });
        loadSettings();
        alert('Settings reset to defaults');
    } catch (_error) {
        alert('Failed to reset settings');
    }
});

// Initial Load
loadSettings();

// Control Logic
const toggleBtn = document.getElementById('toggle-loop-btn');
const panicBtn = document.getElementById('panic-sell-btn');

async function updateLoopStatus() {
    try {
        const res = await fetch('/api/control/status');
        const data = await res.json();

        if (data.running) {
            toggleBtn.textContent = 'STOP TRADING';
            toggleBtn.className = 'btn btn-danger';
        } else {
            toggleBtn.textContent = 'START TRADING';
            toggleBtn.className = 'btn btn-success';
        }
    } catch (error) {
        console.error('Failed to fetch loop status:', error);
    }
}

toggleBtn.addEventListener('click', async () => {
    const isRunning = toggleBtn.textContent.includes('STOP');
    const endpoint = isRunning ? '/api/control/stop' : '/api/control/start';

    try {
        await fetch(endpoint, { method: 'POST' });
        await updateLoopStatus();
    } catch (_error) {
        alert('Failed to toggle trading loop');
    }
});

panicBtn.addEventListener('click', async () => {
    if (!confirm('ARE YOU SURE? This will sell ALL open positions immediately!')) {
        return;
    }

    try {
        const res = await fetch('/api/control/panic-sell', { method: 'POST' });
        const data = await res.json();
        alert(`Panic sell executed! Executions: ${data.data.executions.length}, Failures: ${data.data.failures.length}`);
    } catch (_error) {
        alert('Failed to execute panic sell');
    }
});

// Notification Functions
async function updateNotificationStatus() {
    try {
        const res = await fetch('/api/notifications/status');
        const data = await res.json();

        const statusEl = document.getElementById('notification-status');
        const testBtn = document.getElementById('test-notification-btn');

        if (data.configured) {
            statusEl.textContent = 'CONFIGURED';
            statusEl.className = 'status-value connected';
            testBtn.disabled = false;
        } else {
            statusEl.textContent = 'NOT CONFIGURED';
            statusEl.className = 'status-value disconnected';
            testBtn.disabled = true;
        }
    } catch (error) {
        console.error('Failed to fetch notification status:', error);
    }
}

const testNotificationBtn = document.getElementById('test-notification-btn');
if (testNotificationBtn) {
    testNotificationBtn.addEventListener('click', async () => {
        const resultEl = document.getElementById('notification-result');

        testNotificationBtn.disabled = true;
        testNotificationBtn.textContent = 'Sending...';

        try {
            const res = await fetch('/api/notifications/test', { method: 'POST' });
            const data = await res.json();

            resultEl.classList.remove('hidden');

            if (data.success) {
                resultEl.className = 'notification-result success';
                resultEl.textContent = '✅ ' + data.message;
            } else {
                resultEl.className = 'notification-result error';
                resultEl.textContent = '❌ ' + data.message;
            }

            // Hide result after 5 seconds
            setTimeout(() => {
                resultEl.classList.add('hidden');
            }, 5000);
        } catch (_error) {
            resultEl.classList.remove('hidden');
            resultEl.className = 'notification-result error';
            resultEl.textContent = '❌ Failed to send test notification';
        } finally {
            testNotificationBtn.disabled = false;
            testNotificationBtn.textContent = '🧪 Send Test Notification';
        }
    });
}

// Initial notification status check
updateNotificationStatus();
