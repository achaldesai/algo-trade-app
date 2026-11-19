// Strategy parameter form, shared by the Backtest and Live strategies panels.
// Renders form fields from a strategy's paramSchema (GET /api/strategies),
// reads them back, and hides params that only apply to another choice
// (`visibleWhen`, e.g. order size vs % of equity). Exposed as window.ParamsForm.
(function () {
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]);
    }

    /** Fill `container` with fields for `schema`, set to `values` (defaults otherwise). */
    function render(container, schema, values, idPrefix) {
        const valueOf = (p) => (values && values[p.key] !== undefined ? values[p.key] : p.default);
        container.innerHTML = (schema || []).map((p) => {
            const id = `${idPrefix}-${escapeHtml(p.key)}`;
            const value = valueOf(p);
            const title = p.description ? ` title="${escapeHtml(p.description)}"` : '';
            let input;
            if (p.type === 'select') {
                input = `<select id="${id}" data-param="${escapeHtml(p.key)}" data-type="select">${
                    (p.options || []).map((o) => `<option value="${escapeHtml(o.value)}"${
                        String(o.value) === String(value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')
                }</select>`;
            } else if (p.type === 'boolean') {
                input = `<input type="checkbox" id="${id}" data-param="${escapeHtml(p.key)}" data-type="boolean"${value ? ' checked' : ''}>`;
            } else {
                const attrs = ['min', 'max', 'step']
                    .filter((k) => p[k] !== undefined)
                    .map((k) => ` ${k}="${escapeHtml(p[k])}"`).join('');
                const type = p.type === 'number' ? 'number' : 'text';
                input = `<input type="${type}" id="${id}" data-param="${escapeHtml(p.key)}" data-type="${escapeHtml(p.type)}" value="${escapeHtml(value)}"${attrs}>`;
            }
            const when = p.visibleWhen
                ? ` data-visible-key="${escapeHtml(p.visibleWhen.key)}" data-visible-equals="${escapeHtml(p.visibleWhen.equals)}"`
                : '';
            return `<div class="form-group"${title}${when}><label for="${id}">${escapeHtml(p.label)}</label>${input}</div>`;
        }).join('');
        updateVisibility(container);
    }

    function read(container) {
        const params = {};
        container.querySelectorAll('[data-param]').forEach((el) => {
            const type = el.dataset.type;
            if (type === 'boolean') params[el.dataset.param] = el.checked;
            else if (type === 'number') params[el.dataset.param] = Number(el.value);
            else params[el.dataset.param] = el.value;
        });
        return params;
    }

    function updateVisibility(container) {
        const values = read(container);
        container.querySelectorAll('[data-visible-key]').forEach((group) => {
            group.classList.toggle('hidden', String(values[group.dataset.visibleKey]) !== group.dataset.visibleEquals);
        });
    }

    /** Keep `visibleWhen` fields in step as the user changes the form. */
    function bind(container) {
        container.addEventListener('change', () => updateVisibility(container));
    }

    window.ParamsForm = { render, read, updateVisibility, bind, escapeHtml };
})();
