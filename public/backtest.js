/* global apiFetch, formatCurrency -- defined in dashboard.js, loaded first */
// Backtest panel. Loaded after dashboard.js; uses its apiFetch() and formatCurrency().
// Nothing here polls: data loads when the panel is opened and after each action.
(function () {
    const section = document.getElementById('backtest-section');
    const form = document.getElementById('backtest-form');
    const strategySelect = document.getElementById('bt-strategy');
    const paramsEl = document.getElementById('bt-params');
    const runBtn = document.getElementById('bt-run-btn');
    const messageEl = document.getElementById('bt-message');
    const resultsEl = document.getElementById('bt-results');
    const historyBody = document.getElementById('bt-history-body');

    let strategies = [];
    let activeRunId = null;
    let chart = null;
    let equitySeries = null;
    let strategiesLoaded = false;

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]);
    }

    const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
    const num = (v) => (v === null || v === undefined ? '—' : v.toFixed(2));
    const tone = (v) => (v > 0 ? 'profit' : v < 0 ? 'loss' : '');

    function showMessage(text, kind) {
        messageEl.textContent = text;
        messageEl.className = `notification-result ${kind}`;
    }

    function hideMessage() {
        messageEl.className = 'notification-result hidden';
    }

    async function readError(res) {
        try {
            const body = await res.json();
            const message = body.message || body.error || `Request failed (${res.status})`;
            // Validation errors list the offending fields in `details`.
            const fields = Array.isArray(body.details)
                ? body.details.map((d) => `${d.path}: ${d.message}`).join('; ')
                : '';
            return fields ? `${message} — ${fields}` : message;
        } catch {
            return `Request failed (${res.status})`;
        }
    }

    // ─── Form ────────────────────────────────────────────────────────────────

    function setDefaultDates() {
        const to = new Date();
        to.setDate(to.getDate() - 1);
        const from = new Date(to);
        from.setFullYear(from.getFullYear() - 5);
        document.getElementById('bt-to').value = to.toISOString().slice(0, 10);
        document.getElementById('bt-from').value = from.toISOString().slice(0, 10);
    }

    function renderParams() {
        const strategy = strategies.find((s) => s.id === strategySelect.value);
        if (!strategy) {
            paramsEl.innerHTML = '';
            return;
        }
        paramsEl.innerHTML = strategy.paramSchema.map((p) => {
            const id = `bt-param-${escapeHtml(p.key)}`;
            const title = p.description ? ` title="${escapeHtml(p.description)}"` : '';
            let input;
            if (p.type === 'select') {
                input = `<select id="${id}" data-param="${escapeHtml(p.key)}" data-type="select">${
                    (p.options || []).map((o) => `<option value="${escapeHtml(o.value)}"${
                        o.value === p.default ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')
                }</select>`;
            } else if (p.type === 'boolean') {
                input = `<input type="checkbox" id="${id}" data-param="${escapeHtml(p.key)}" data-type="boolean"${p.default ? ' checked' : ''}>`;
            } else {
                const attrs = ['min', 'max', 'step']
                    .filter((k) => p[k] !== undefined)
                    .map((k) => ` ${k}="${escapeHtml(p[k])}"`).join('');
                const type = p.type === 'number' ? 'number' : 'text';
                input = `<input type="${type}" id="${id}" data-param="${escapeHtml(p.key)}" data-type="${escapeHtml(p.type)}" value="${escapeHtml(p.default)}"${attrs}>`;
            }
            return `<div class="form-group"${title}><label for="${id}">${escapeHtml(p.label)}</label>${input}</div>`;
        }).join('');
    }

    function readParams() {
        const params = {};
        paramsEl.querySelectorAll('[data-param]').forEach((el) => {
            const type = el.dataset.type;
            if (type === 'boolean') params[el.dataset.param] = el.checked;
            else if (type === 'number') params[el.dataset.param] = Number(el.value);
            else params[el.dataset.param] = el.value;
        });
        return params;
    }

    async function loadStrategies() {
        const res = await apiFetch('/api/strategies', {}, true);
        if (!res.ok) throw new Error(await readError(res));
        strategies = (await res.json()).data.filter((s) => s.backtestable);
        strategySelect.innerHTML = strategies.length
            ? strategies.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')
            : '<option value="">No backtestable strategies</option>';
        runBtn.disabled = strategies.length === 0;
        renderParams();
    }

    async function runBacktest(event) {
        event.preventDefault();
        hideMessage();
        const body = {
            strategyId: strategySelect.value,
            symbols: document.getElementById('bt-symbols').value.split(',').map((s) => s.trim()).filter(Boolean),
            from: document.getElementById('bt-from').value,
            to: document.getElementById('bt-to').value,
            initialCapital: Number(document.getElementById('bt-capital').value),
            costBps: Number(document.getElementById('bt-cost').value),
            params: readParams(),
        };

        runBtn.disabled = true;
        runBtn.textContent = 'Running…';
        try {
            const res = await apiFetch('/api/backtest', { method: 'POST', body: JSON.stringify(body) }, true);
            if (!res.ok) throw new Error(await readError(res));
            const run = (await res.json()).data;
            renderRun(run);
            await loadHistory();
        } catch (error) {
            showMessage(error.message, 'error');
        } finally {
            runBtn.disabled = false;
            runBtn.textContent = 'Run Backtest';
        }
    }

    // ─── Results ─────────────────────────────────────────────────────────────

    function metricTile(label, value, cls, hint) {
        return `<div class="bt-metric"><div class="label">${label}</div>` +
            `<div class="value ${cls || ''}">${value}</div>` +
            (hint ? `<div class="hint">${hint}</div>` : '') + '</div>';
    }

    function renderRun(run) {
        activeRunId = run.id;
        const m = run.metrics;
        resultsEl.classList.remove('hidden');
        document.getElementById('bt-results-title').textContent =
            `${run.strategyName} · ${run.symbols.join(', ')} · ${run.from} → ${run.to}`;

        document.getElementById('bt-metrics').innerHTML = [
            metricTile('Total Return', pct(m.totalReturnPct), tone(m.totalReturnPct), `${formatCurrency(m.startEquity)} → ${formatCurrency(m.endEquity)}`),
            metricTile('Buy &amp; Hold', pct(m.benchmarkReturnPct), tone(m.benchmarkReturnPct), 'equal weight, fully invested'),
            metricTile('Avg. Exposure', `${m.exposurePct.toFixed(1)}%`, '', 'of equity in positions'),
            metricTile('CAGR', pct(m.cagrPct), tone(m.cagrPct)),
            metricTile('Max Drawdown', `${m.maxDrawdownPct.toFixed(2)}%`, m.maxDrawdownPct > 0 ? 'loss' : ''),
            metricTile('Sharpe', num(m.sharpe), tone(m.sharpe ?? 0)),
            metricTile('Round Trips', String(m.roundTrips), '', `${m.trades} fills`),
            metricTile('Win Rate', m.winRatePct === null ? '—' : `${m.winRatePct.toFixed(1)}%`),
            metricTile('Profit Factor', num(m.profitFactor)),
        ].join('');

        const notes = [...run.warnings];
        if (run.rejections.length) {
            notes.push(`${run.rejections.length} order(s) not filled, e.g. ${run.rejections[0].date} ${run.rejections[0].symbol}: ${run.rejections[0].reason}`);
        }
        const warningsEl = document.getElementById('bt-warnings');
        warningsEl.innerHTML = notes.map(escapeHtml).join('<br>');
        warningsEl.classList.toggle('hidden', notes.length === 0);

        document.getElementById('bt-trades-summary').textContent = `Trades (${run.trades.length})`;
        document.getElementById('bt-trades-body').innerHTML = run.trades.length
            ? run.trades.map((t) => `<tr>
                <td>${escapeHtml(t.date)}</td>
                <td class="symbol">${escapeHtml(t.symbol)}</td>
                <td>${escapeHtml(t.side)}</td>
                <td>${t.quantity}</td>
                <td>${formatCurrency(t.price)}</td>
                <td>${formatCurrency(t.cost)}</td>
                <td class="${t.pnl === undefined ? 'neutral' : tone(t.pnl)}">${t.pnl === undefined ? '—' : formatCurrency(t.pnl)}</td>
            </tr>`).join('')
            : '<tr><td colspan="7" class="empty-state">No trades — the strategy never signalled in this period</td></tr>';

        drawEquity(run.equityCurve);
        highlightHistory();
    }

    function drawEquity(curve) {
        const container = document.getElementById('bt-chart');
        const css = getComputedStyle(document.documentElement);
        const color = (name) => css.getPropertyValue(name).trim();
        if (!chart) {
            chart = LightweightCharts.createChart(container, { width: container.clientWidth, height: 280 });
            equitySeries = chart.addLineSeries({ lineWidth: 2 });
            window.addEventListener('resize', () => chart.applyOptions({ width: container.clientWidth }));
        }
        // Re-read theme colors each time so a theme switch is picked up on the next run.
        chart.applyOptions({
            layout: { background: { type: 'solid', color: color('--card-bg') }, textColor: color('--text-secondary') },
            grid: { vertLines: { color: color('--border') }, horzLines: { color: color('--border') } },
        });
        equitySeries.applyOptions({ color: color('--accent') });
        equitySeries.setData(curve.map((p) => ({ time: p.date, value: p.equity })));
        chart.timeScale().fitContent();
    }

    // ─── History ─────────────────────────────────────────────────────────────

    function highlightHistory() {
        historyBody.querySelectorAll('tr[data-id]').forEach((row) => {
            row.classList.toggle('active', row.dataset.id === activeRunId);
        });
    }

    async function loadHistory() {
        const res = await apiFetch('/api/backtest', {}, true);
        if (!res.ok) throw new Error(await readError(res));
        const runs = (await res.json()).data;
        historyBody.innerHTML = runs.length
            ? runs.map((r) => `<tr class="bt-history-row" data-id="${escapeHtml(r.id)}">
                <td>${escapeHtml(new Date(r.createdAt).toLocaleString('en-IN'))}</td>
                <td>${escapeHtml(r.strategyName)}</td>
                <td>${escapeHtml(r.symbols.join(', '))}</td>
                <td>${escapeHtml(r.from)} → ${escapeHtml(r.to)}</td>
                <td class="${tone(r.metrics.totalReturnPct)}">${pct(r.metrics.totalReturnPct)}</td>
                <td>${pct(r.metrics.benchmarkReturnPct)}</td>
                <td>${r.metrics.maxDrawdownPct.toFixed(2)}%</td>
                <td><button type="button" class="btn btn-danger btn-sm" data-delete="${escapeHtml(r.id)}">Delete</button></td>
            </tr>`).join('')
            : '<tr><td colspan="8" class="empty-state">No saved backtests</td></tr>';
        highlightHistory();
    }

    async function openRun(id) {
        hideMessage();
        const res = await apiFetch(`/api/backtest/${encodeURIComponent(id)}`, {}, true);
        if (!res.ok) throw new Error(await readError(res));
        renderRun((await res.json()).data);
    }

    async function deleteRun(id) {
        if (!confirm('Delete this backtest?')) return;
        const res = await apiFetch(`/api/backtest/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
        if (!res.ok && res.status !== 404) throw new Error(await readError(res));
        if (id === activeRunId) {
            activeRunId = null;
            resultsEl.classList.add('hidden');
        }
        await loadHistory();
    }

    historyBody.addEventListener('click', (event) => {
        const del = event.target.closest('[data-delete]');
        const row = event.target.closest('tr[data-id]');
        const action = del ? deleteRun(del.dataset.delete) : row ? openRun(row.dataset.id) : null;
        if (action) action.catch((error) => showMessage(error.message, 'error'));
    });

    // ─── Wiring ──────────────────────────────────────────────────────────────

    strategySelect.addEventListener('change', renderParams);
    form.addEventListener('submit', runBacktest);
    setDefaultDates();

    // Load when the panel is opened (the user is logged in by then). History is
    // re-read on every open so it follows logout / login as a different user.
    section.addEventListener('toggle', () => {
        if (!section.open) return;
        const loads = [loadHistory()];
        if (!strategiesLoaded) loads.push(loadStrategies().then(() => { strategiesLoaded = true; }));
        Promise.all(loads).catch((error) => showMessage(error.message, 'error'));
    });
})();
