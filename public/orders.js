(function () {
    "use strict";

    const POLL_INTERVAL_MS = 5000;

    const $ = (id) => document.getElementById(id);

    const fmtINR = (n) => {
        if (n === null || n === undefined || Number.isNaN(n)) return "—";
        const sign = n < 0 ? "-" : "";
        const abs = Math.abs(n).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
        return `${sign}₹${abs}`;
    };

    const fmtSignedINR = (n) => {
        if (n === null || n === undefined || Number.isNaN(n)) return "—";
        const sign = n > 0 ? "+" : n < 0 ? "-" : "";
        const abs = Math.abs(n).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
        return `${sign}₹${abs}`;
    };

    const fmtQty = (n) =>
        n === null || n === undefined ? "—" : n.toLocaleString("en-IN");

    const fmtTime = (iso) => {
        if (!iso) return "—";
        const d = new Date(iso);
        return d.toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    };

    const fmtDate = (iso) => {
        if (!iso) return "—";
        const d = new Date(iso);
        return d.toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
        });
    };

    const setPnlClass = (el, value) => {
        el.classList.remove("pnl-pos", "pnl-neg");
        if (value > 0) el.classList.add("pnl-pos");
        else if (value < 0) el.classList.add("pnl-neg");
    };

    const escape = (s) =>
        String(s ?? "").replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );

    async function apiFetch(url) {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Request failed: ${res.status}`);
        }
        return res.json();
    }

    function renderSummary(summary) {
        const total = summary.totalPnL ?? 0;
        const realized = summary.realizedPnL ?? 0;
        const unrealized = summary.unrealizedPnL ?? 0;

        const totalEl = $("total-pnl");
        totalEl.textContent = fmtSignedINR(total);
        setPnlClass(totalEl, total);

        const realizedEl = $("realized-pnl");
        realizedEl.textContent = fmtSignedINR(realized);
        setPnlClass(realizedEl, realized);

        const unrealizedEl = $("unrealized-pnl");
        unrealizedEl.textContent = fmtSignedINR(unrealized);
        setPnlClass(unrealizedEl, unrealized);

        $("trade-count").textContent = String(summary.tradeCount ?? 0);
    }

    function renderPositions(positions) {
        const tbody = $("positions-tbody");
        $("positions-count").textContent = `${positions.length} open`;

        if (positions.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="7" class="empty-row">No open positions.</td></tr>';
            return;
        }

        tbody.innerHTML = positions
            .map((p) => {
                const pnl = p.unrealizedPnl ?? 0;
                const cls = pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : "";
                const rcls = (p.realizedPnl ?? 0) > 0
                    ? "pnl-pos"
                    : (p.realizedPnl ?? 0) < 0
                    ? "pnl-neg"
                    : "";
                return `
                    <tr>
                        <td><strong>${escape(p.symbol)}</strong></td>
                        <td class="num">${fmtQty(p.quantity)}</td>
                        <td class="num">${fmtINR(p.entryPrice)}</td>
                        <td class="num">${fmtINR(p.currentPrice)}</td>
                        <td class="num ${cls}">${fmtSignedINR(pnl)}</td>
                        <td class="num ${rcls}">${fmtSignedINR(p.realizedPnl ?? 0)}</td>
                        <td>${escape(p.position ?? "")}</td>
                    </tr>
                `;
            })
            .join("");
    }

    function renderOrders(trades) {
        const tbody = $("orders-tbody");
        $("orders-count").textContent = `${trades.length} orders`;

        if (trades.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="7" class="empty-row">No orders today.</td></tr>';
            return;
        }

        // Newest first
        const sorted = [...trades].sort(
            (a, b) =>
                new Date(b.executedAt).getTime() -
                new Date(a.executedAt).getTime()
        );

        tbody.innerHTML = sorted
            .map((t) => {
                const sideClass = t.side === "BUY" ? "buy" : "sell";
                const value = (t.quantity ?? 0) * (t.price ?? 0);
                return `
                    <tr>
                        <td>${escape(fmtTime(t.executedAt))}</td>
                        <td><strong>${escape(t.symbol)}</strong></td>
                        <td><span class="side-badge ${sideClass}">${escape(t.side)}</span></td>
                        <td class="num">${fmtQty(t.quantity)}</td>
                        <td class="num">${fmtINR(t.price)}</td>
                        <td class="num">${fmtINR(value)}</td>
                        <td>${escape(t.notes ?? "")}</td>
                    </tr>
                `;
            })
            .join("");
    }

    function renderMode(mode) {
        const badge = $("mode-badge");
        const isPaper = Boolean(mode && mode.paperTrading);
        if (isPaper) {
            badge.textContent = "Paper";
            badge.className = "mode-badge paper";
        } else {
            const provider = mode && mode.brokerProvider ? mode.brokerProvider : "Live";
            badge.textContent = provider === "paper" ? "Paper" : "Live";
            badge.className = provider === "paper" ? "mode-badge paper" : "mode-badge live";
        }
    }

    async function refresh() {
        try {
            const json = await apiFetch("/api/paper/pnl");
            const data = json.data ?? json;
            renderSummary(data.summary ?? {});
            renderPositions(data.positions ?? []);
            renderOrders(data.trades ?? []);
            renderMode(data.mode ?? {});
            $("today-date").textContent = fmtDate(data.generatedAt ?? new Date().toISOString());
            $("last-updated").textContent = fmtTime(
                data.generatedAt ?? new Date().toISOString()
            );
        } catch (e) {
            console.error("Failed to refresh console:", e);
        }
    }

    function start() {
        $("console-app").hidden = false;
        refresh();
        setInterval(refresh, POLL_INTERVAL_MS);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
