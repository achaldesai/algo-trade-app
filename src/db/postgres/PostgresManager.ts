import { Pool, type PoolConfig } from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import logger from "../../utils/logger";

/**
 * PostgresManager manages a pg.Pool connection and runs schema migrations.
 *
 * Lifecycle:
 *   const pg = new PostgresManager(connectionString, { min: 2, max: 10 });
 *   await pg.connect();     // creates pool + runs migrations
 *   // ... use pg.pool
 *   await pg.close();       // drains pool
 */
export class PostgresManager {
    private _pool: Pool | null = null;

    constructor(
        private readonly connectionString: string,
        private readonly poolConfig: { min: number; max: number }
    ) { }

    /**
     * Create the connection pool and run schema migrations.
     */
    async connect(): Promise<void> {
        if (this._pool) return;

        const config: PoolConfig = {
            connectionString: this.connectionString,
            min: this.poolConfig.min,
            max: this.poolConfig.max,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        };

        this._pool = new Pool(config);

        // Verify connectivity
        const client = await this._pool.connect();
        try {
            const result = await client.query("SELECT NOW()");
            logger.info(
                { serverTime: result.rows[0].now },
                "PostgreSQL connected"
            );
        } finally {
            client.release();
        }

        // Run schema migration
        await this.migrate();
    }

    /**
     * Run schema migration — creates tables if they don't exist.
     */
    async migrate(): Promise<void> {
        const schemaPath = await this.resolveSchemaPath();
        const sql = await fs.readFile(schemaPath, "utf-8");
        await this.pool.query(sql);
        logger.info({ schemaPath }, "PostgreSQL schema migration complete");
    }

    /**
     * Get the pool (throws if not connected).
     */
    get pool(): Pool {
        if (!this._pool) {
            throw new Error("PostgresManager is not connected. Call connect() first.");
        }
        return this._pool;
    }

    /**
     * Check if connected.
     */
    get isConnected(): boolean {
        return this._pool !== null;
    }

    /**
     * Drain and close the pool.
     */
    async close(): Promise<void> {
        if (this._pool) {
            await this._pool.end();
            this._pool = null;
            logger.info("PostgreSQL pool closed");
        }
    }

    private async resolveSchemaPath(): Promise<string> {
        const candidates = [
            path.join(__dirname, "schema.sql"),
            path.resolve(process.cwd(), "dist/db/postgres/schema.sql"),
            path.resolve(process.cwd(), "src/db/postgres/schema.sql"),
        ];

        for (const candidate of candidates) {
            try {
                await fs.access(candidate);
                return candidate;
            } catch {
                // Keep trying next candidate
            }
        }

        throw new Error(
            `Unable to locate PostgreSQL schema.sql. Checked: ${candidates.join(", ")}`
        );
    }
}
