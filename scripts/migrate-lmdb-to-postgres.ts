/**
 * LMDB → PostgreSQL Migration Script
 *
 * Reads users, trades, and audit logs from LMDB and inserts them into PostgreSQL.
 * Run once after configuring DATABASE_URL.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate-lmdb-to-postgres.ts
 */

import { DatabaseManager } from "../src/db/DatabaseManager";
import { PostgresManager } from "../src/db/postgres/PostgresManager";
import env from "../src/config/env";

async function main() {
    if (!env.databaseUrl) {
        console.error("ERROR: DATABASE_URL is not set. Set it in .env or as an environment variable.");
        process.exit(1);
    }

    console.log("=== LMDB → PostgreSQL Migration ===\n");

    // Open LMDB
    const dbManager = new DatabaseManager(env.portfolioStorePath);
    await dbManager.open();
    console.log(`LMDB opened at: ${env.portfolioStorePath}`);

    // Connect PostgreSQL
    const pgManager = new PostgresManager(env.databaseUrl, {
        min: 2,
        max: 10,
    });
    await pgManager.connect();
    console.log("PostgreSQL connected and schema migrated.\n");

    const pool = pgManager.pool;
    const handles = dbManager.handles;

    // ── Migrate Users ─────────────────────────────────────────────────────────

    let userCount = 0;
    let userSkipped = 0;

    console.log("Migrating users...");
    for (const { value } of handles.users.getRange()) {
        try {
            await pool.query(
                `INSERT INTO users (id, username, password_hash, role, created_at)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    value.id,
                    value.username,
                    value.passwordHash,
                    value.role,
                    new Date(value.createdAt),
                ]
            );
            userCount++;
        } catch (err) {
            console.warn(`  ⚠ Skipped user ${value.username}: ${(err as Error).message}`);
            userSkipped++;
        }
    }
    console.log(`  ✓ Users: ${userCount} migrated, ${userSkipped} skipped\n`);

    // ── Migrate Trades ────────────────────────────────────────────────────────

    let tradeCount = 0;
    let tradeSkipped = 0;

    console.log("Migrating trades...");
    for (const { value } of handles.trades.getRange()) {
        try {
            await pool.query(
                `INSERT INTO trades (id, user_id, symbol, side, quantity, price, executed_at, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    value.id,
                    value.userId,
                    value.symbol,
                    value.side,
                    value.quantity,
                    value.price,
                    new Date(value.executedAt),
                    value.notes ?? null,
                ]
            );
            tradeCount++;
        } catch (err) {
            console.warn(`  ⚠ Skipped trade ${value.id}: ${(err as Error).message}`);
            tradeSkipped++;
        }
    }
    console.log(`  ✓ Trades: ${tradeCount} migrated, ${tradeSkipped} skipped\n`);

    // ── Migrate Audit Logs ────────────────────────────────────────────────────

    let auditCount = 0;
    let auditSkipped = 0;

    console.log("Migrating audit logs...");
    for (const { value } of handles.auditLogs.getRange()) {
        try {
            await pool.query(
                `INSERT INTO audit_logs (id, user_id, timestamp, event_type, category, symbol, message, details, severity)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    value.id,
                    value.userId,
                    new Date(value.timestamp),
                    value.eventType,
                    value.category,
                    value.symbol ?? null,
                    value.message,
                    value.details ? JSON.stringify(value.details) : null,
                    value.severity,
                ]
            );
            auditCount++;
        } catch (err) {
            console.warn(`  ⚠ Skipped audit log ${value.id}: ${(err as Error).message}`);
            auditSkipped++;
        }
    }
    console.log(`  ✓ Audit logs: ${auditCount} migrated, ${auditSkipped} skipped\n`);

    // ── Summary ───────────────────────────────────────────────────────────────

    console.log("=== Migration Summary ===");
    console.log(`  Users:      ${userCount} migrated, ${userSkipped} skipped`);
    console.log(`  Trades:     ${tradeCount} migrated, ${tradeSkipped} skipped`);
    console.log(`  Audit Logs: ${auditCount} migrated, ${auditSkipped} skipped`);
    console.log("");

    // ── Cleanup ───────────────────────────────────────────────────────────────

    await pgManager.close();
    await dbManager.close();
    console.log("Done. Both databases closed.");
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
