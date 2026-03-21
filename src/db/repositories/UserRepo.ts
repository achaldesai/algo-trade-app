import { randomUUID } from "node:crypto";
import type { UserRecord } from "../DatabaseManager";
import type DatabaseManager from "../DatabaseManager";
import type { User, CreateUserRecord } from "../../types/user";

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * UserRepo manages user accounts.
 *
 * Uses the shared LMDB root. Keys are user UUIDs.
 * Username lookups are a full scan (fine for low user counts).
 */
export class UserRepo {
    private readonly db: DatabaseManager;

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    async createUser(record: CreateUserRecord): Promise<User> {
        const { users } = this.db.handles;

        // Check for duplicate username (case-insensitive)
        const searchLower = record.username.toLowerCase();
        for (const { value } of users.getRange()) {
            if (value.username.toLowerCase() === searchLower) {
                throw new Error(
                    `User with username ${record.username} already exists`
                );
            }
        }

        const user: UserRecord = {
            id: randomUUID(),
            username: record.username,
            passwordHash: record.passwordHash,
            role: record.role,
            createdAt: (record.createdAt ?? new Date()).toISOString(),
        };

        await users.put(user.id, user);
        return toUser(user);
    }

    findUserByUsername(username: string): User | undefined {
        const { users } = this.db.handles;
        const searchLower = username.toLowerCase();

        for (const { value } of users.getRange()) {
            if (value.username.toLowerCase() === searchLower) {
                return toUser(value);
            }
        }
        return undefined;
    }

    findUserById(id: string): User | undefined {
        const { users } = this.db.handles;
        const record = users.get(id);
        return record ? toUser(record) : undefined;
    }

    listUsers(): User[] {
        const { users } = this.db.handles;
        const result: User[] = [];

        for (const { value } of users.getRange()) {
            result.push(toUser(value));
        }

        return result.sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toUser(record: UserRecord): User {
    return {
        id: record.id,
        username: record.username,
        passwordHash: record.passwordHash,
        role: record.role,
        createdAt: new Date(record.createdAt),
    };
}
