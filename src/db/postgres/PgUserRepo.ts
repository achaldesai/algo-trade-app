import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { User, CreateUserRecord } from "../../types/user";

/**
 * PgUserRepo — PostgreSQL-backed user repository.
 *
 * Replaces LMDB full-scan username lookups with indexed SQL queries.
 */
export class PgUserRepo {
    constructor(private readonly pool: Pool) { }

    async createUser(record: CreateUserRecord): Promise<User> {
        const id = randomUUID();
        const createdAt = record.createdAt ?? new Date();

        const result = await this.pool.query(
            `INSERT INTO users (id, username, password_hash, role, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [id, record.username, record.passwordHash, record.role, createdAt]
        );

        return toUser(result.rows[0]);
    }

    async findUserByUsername(username: string): Promise<User | undefined> {
        const result = await this.pool.query(
            "SELECT * FROM users WHERE LOWER(username) = LOWER($1)",
            [username]
        );
        return result.rows[0] ? toUser(result.rows[0]) : undefined;
    }

    async findUserById(id: string): Promise<User | undefined> {
        const result = await this.pool.query(
            "SELECT * FROM users WHERE id = $1",
            [id]
        );
        return result.rows[0] ? toUser(result.rows[0]) : undefined;
    }

    async listUsers(): Promise<User[]> {
        const result = await this.pool.query(
            "SELECT * FROM users ORDER BY created_at ASC"
        );
        return result.rows.map(toUser);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toUser(row: any): User {
    return {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        role: row.role,
        createdAt: new Date(row.created_at),
    };
}
