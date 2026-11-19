/* global apiFetch, formatCurrency, ParamsForm -- from dashboard.js and params-form.js, loaded first */
// Live Strategies panel: switch strategies on or off for live/paper trading,
// set their params and symbols (PUT /api/strategies/config/:id), set paper
// starting cash, and show whether the 15:15 IST daily run will do anything.
// Loads when the panel is opened; status refreshes every 60s while it is open.
(function () {
    const section = document.getElementById('live-section');
    const statusEl = document.getElementById('live-status');
    const cardsEl = document.getElementById('live-cards');
    const firstSaveEl = document.getElementById('live-first-save');
    const messageEl = document.getElementById('live-message');
    const paperForm = document.getElementById('live-paper');
    const paperInput = document.getElementById('live-paper-cash');
    const paperBalance = document.getElementById('live-paper-balance');
    const esc = (v) => ParamsForm.escapeHtml(v);

    let configs = [];
    let status = null;
    let refreshTimer = null;

    function showMessage(text, kind) {
        messageEl.textContent = text;
        messageEl.className = `notification-result ${kind}`;
    }

    async function readError(res) {
        try {
            const body = await res.json();
            const fields = Array.isArray(body.details) ? body.details.map((d) => `${d.path}: ${d.message}`).join('; ') : '';
            const message = body.message || body.error || `Request failed (${res.status})`;
            return fields ? `${message} (${fields})` : message;
        } catch {
            return `Request failed (${res.status})`;
        }
    }

    async function getJson(url) {
        const res = await apiFetch(url, {}, true);
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()).data;
    }

    const ist = (iso) => new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });

    // ─── Status ──────────────────────────────────────────────────────────────

    function renderStatus() {
        if (!status) return;
        const lines = [];
        lines.push(status.tradingOn
            ? '<div><strong>Trading is on.</strong></div>'
            : '<div class="bt-warnings">Trading is off. Daily strategies only run while trading is on (START TRADING, admin).</div>');
        lines.push(`<div>Next daily run: <strong>${status.nextRunAt ? esc(ist(status.nextRunAt)) + ' IST' : 'not scheduled'}</strong></div>`);
        const last = status.lastRun;
        if (last) {
            const result = last.skipped
                ? `skipped: ${esc(last.skipped)}`
                : `${last.evaluations} evaluation(s), ${last.orders} order(s), ${last.errors} error(s)`;
            lines.push(`<div>Last run: ${esc(ist(last.ranAt))} IST · ${result}</div>`);
            (last.warnings || []).forEach((w) => lines.push(`<div class="live-muted">${esc(w)}</div>`));
        }
        if (status.account) {
            lines.push(`<div>Account: cash <strong>${formatCurrency(status.account.cash)}</strong> · equity ${formatCurrency(status.account.equity)}</div>`);
        } else {
            lines.push('<div class="live-muted">Account balance unavailable: "% of equity" buys will be skipped until it can be read.</div>');
        }
        if (status.strategies.length === 0) {
            lines.push('<div class="live-muted">No daily strategy is switched on, so the daily run has nothing to do.</div>');
        }
        status.strategies.forEach((s) => {
            const skipped = s.notTracked.length ? ` · <span class="loss">not in WATCHLIST, skipped: ${esc(s.notTracked.join(', '))}</span>` : '';
            lines.push(`<div>${esc(s.name)}: ${esc(s.symbols.join(', '))} · ${s.sizing === 'percent' ? '% of equity' : 'fixed shares'}${skipped}</div>`);
        });
        statusEl.innerHTML = lines.join('');

        paperForm.classList.toggle('hidden', !status.paperMode);
        paperBalance.textContent = status.paperMode && status.account ? `Balance now: ${formatCurrency(status.account.cash)} cash` : '';
    }

    async function loadStatus() {
        status = await getJson('/api/strategies/daily-status');
        renderStatus();
        if (status.paperMode && document.activeElement !== paperInput) {
            const res = await apiFetch('/api/settings/paper-cash', {}, true);
            if (res.ok) paperInput.value = (await res.json()).startingCash;
        }
    }

    // ─── Strategy cards ──────────────────────────────────────────────────────

    // A user with no saved config runs every tick strategy with defaults; once
    // any config is saved, only the strategies switched on run.
    const hasAnyConfig = () => configs.some((c) => c.userConfig);
    const effectiveEnabled = (c) => (c.userConfig ? c.userConfig.enabled : !hasAnyConfig() && c.timeframe === 'tick');

    function renderCards() {
        firstSaveEl.classList.toggle('hidden', hasAnyConfig());
        firstSaveEl.textContent = 'You have no saved strategy settings, so every live-tick strategy (VWAP) runs with defaults. '
            + 'Once you save any strategy here, only the strategies switched on below will run, VWAP included.';

        cardsEl.innerHTML = configs.map((c) => {
            const id = esc(c.strategyId);
            const daily = c.timeframe === '1day';
            const symbols = c.userConfig && c.userConfig.symbols ? c.userConfig.symbols.join(', ') : '';
            const defaultNote = !c.userConfig && effectiveEnabled(c) ? ' <span class="live-muted">(on by default)</span>' : '';
            return `<div class="live-card" data-strategy="${id}">
                <div class="live-card-head">
                    <h3>${esc(c.name)}</h3>
                    <span class="live-chip">${daily ? 'Daily, 15:15 IST' : 'Every live tick'}</span>
                    <label class="live-toggle"><input type="checkbox" data-role="enabled"${effectiveEnabled(c) ? ' checked' : ''}> Enabled${defaultNote}</label>
                </div>
                ${daily ? `<div class="settings-form">
                    <div class="form-group"><label for="live-${id}-symbols">Symbols (empty = whole watchlist)</label>
                        <input type="text" id="live-${id}-symbols" data-role="symbols" value="${esc(symbols)}" placeholder="${esc((status && status.trackedSymbols || []).join(', '))}"></div>
                    <div class="bt-params" data-role="params"></div>
                </div>` : '<p class="live-muted">Uses its default settings on every live price tick.</p>'}
                <div class="live-card-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="save">Save</button>
                    ${c.userConfig ? '<button type="button" class="btn btn-sm" data-action="reset">Reset to defaults</button>' : ''}
                    <span class="live-muted" data-role="saved">${c.userConfig ? `Saved ${esc(new Date(c.userConfig.updatedAt).toLocaleString('en-IN'))}` : 'Not saved'}</span>
                </div>
            </div>`;
        }).join('');

        configs.filter((c) => c.timeframe === '1day').forEach((c) => {
            const container = cardsEl.querySelector(`[data-strategy="${CSS.escape(c.strategyId)}"] [data-role="params"]`);
            ParamsForm.render(container, c.paramSchema, c.userConfig ? c.userConfig.params : c.defaultParams, `live-${c.strategyId}`);
            ParamsForm.bind(container);
        });
    }

    async function loadConfigs() {
        configs = await getJson('/api/strategies/config');
        renderCards();
    }

    async function save(card) {
        const strategyId = card.dataset.strategy;
        const paramsEl = card.querySelector('[data-role="params"]');
        const symbolsEl = card.querySelector('[data-role="symbols"]');
        const body = {
            enabled: card.querySelector('[data-role="enabled"]').checked,
            ...(paramsEl ? { params: ParamsForm.read(paramsEl) } : {}),
            ...(symbolsEl ? { symbols: symbolsEl.value.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        };
        const res = await apiFetch(`/api/strategies/config/${encodeURIComponent(strategyId)}`, { method: 'PUT', body: JSON.stringify(body) }, true);
        if (!res.ok) throw new Error(await readError(res));
        showMessage(`Saved ${strategyId}: ${body.enabled ? 'on' : 'off'}.`, 'success');
        await Promise.all([loadConfigs(), loadStatus()]);
    }

    async function reset(card) {
        const strategyId = card.dataset.strategy;
        const res = await apiFetch(`/api/strategies/config/${encodeURIComponent(strategyId)}`, { method: 'DELETE' }, true);
        if (!res.ok && res.status !== 404) throw new Error(await readError(res));
        showMessage(`Reset ${strategyId} to defaults.`, 'success');
        await Promise.all([loadConfigs(), loadStatus()]);
    }

    cardsEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const card = button.closest('.live-card');
        button.disabled = true;
        (button.dataset.action === 'save' ? save(card) : reset(card))
            .catch((error) => showMessage(error.message, 'error'))
            .finally(() => { button.disabled = false; });
    });
    cardsEl.addEventListener('input', (event) => {
        const card = event.target.closest('.live-card');
        if (card) card.classList.add('unsaved');
    });
    cardsEl.addEventListener('change', (event) => {
        const card = event.target.closest('.live-card');
        if (card) card.classList.add('unsaved');
    });

    paperForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const startingCash = Number(paperInput.value);
        apiFetch('/api/settings/paper-cash', { method: 'PUT', body: JSON.stringify({ startingCash }) }, true)
            .then(async (res) => {
                if (!res.ok) throw new Error(await readError(res));
                showMessage(`Paper starting cash set to ${formatCurrency(startingCash)}.`, 'success');
                await loadStatus();
            })
            .catch((error) => showMessage(error.message, 'error'));
    });

    // ─── Loading ─────────────────────────────────────────────────────────────

    // One load at a time: opening the panel from "Use these settings live"
    // fires 'toggle' too, and a second render would wipe the prefilled card.
    let loading = null;
    function load() {
        loading = loading || (async () => {
            await loadStatus(); // first, so cards can show the watchlist as a placeholder
            await loadConfigs();
        })().finally(() => { loading = null; });
        return loading;
    }

    section.addEventListener('toggle', () => {
        clearInterval(refreshTimer);
        refreshTimer = null;
        if (!section.open) return;
        load().catch((error) => showMessage(error.message, 'error'));
        refreshTimer = setInterval(() => loadStatus().catch(() => {}), 60_000);
    });

    // Called from the Backtest panel: copy a saved run's settings into its
    // strategy's card, unsaved, for the user to review and save.
    async function prefill(run) {
        if (!section.open) section.open = true; // fires 'toggle', which loads
        await load();
        const card = cardsEl.querySelector(`[data-strategy="${CSS.escape(run.strategyId)}"]`);
        if (!card) {
            showMessage(`${run.strategyId} can't run live.`, 'error');
            return;
        }
        const paramsEl = card.querySelector('[data-role="params"]');
        const config = configs.find((c) => c.strategyId === run.strategyId);
        if (paramsEl) {
            ParamsForm.render(paramsEl, config.paramSchema, run.params, `live-${run.strategyId}`);
        }
        const symbolsEl = card.querySelector('[data-role="symbols"]');
        if (symbolsEl) symbolsEl.value = run.symbols.join(', ');
        card.querySelector('[data-role="enabled"]').checked = true;
        card.classList.add('unsaved');
        showMessage(`Loaded ${run.strategyName} settings and symbols from the backtest. Review them, then press Save.`, 'success');
        card.scrollIntoView({ block: 'center' });
    }

    window.LivePanel = { prefill };
})();
