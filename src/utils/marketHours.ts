/**
 * Pure market-hours helpers for the Indian (NSE) market.
 * No side effects — safe to use from services and tests.
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Return true if `date` falls within NSE market hours on a weekday.
 * Market hours: Monday–Friday, 09:15–15:30 IST (both endpoints inclusive).
 * Saturday (6) and Sunday (0) are excluded.
 */
export function isIndianMarketHours(date: Date): boolean {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);

    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;

    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const marketOpen = 9 * 60 + 15; // 09:15
    const marketClose = 15 * 60 + 30; // 15:30

    return minutes >= marketOpen && minutes <= marketClose;
}
