import { randomUUID } from "node:crypto";
import { open, type Database } from "lmdb";
import path from "node:path";
import fs from "node:fs/promises";
import type { User, CreateUserRecord } from "../types/user";

export interface UserRepository {
    initialize(): Promise<void>;
    createUser(record: CreateUserRecord): Promise<User>;
    findUserByUsername(username: string): Promise<User | undefined>;
    findUserById(id: string): Promise<User | undefined>;
    listUsers(): Promise<User[]>;
}

export class LmdbUserRepository implements UserRepository {
    private db: Database<User> | null = null;
    private readonly ZERODHA_KEY = "auth:zerodha";

    constructor(private readonly storePath: string) { }

    async initialize(): Promise<void> {
        if (this.db) return;

        await fs.mkdir(this.storePath, { recursive: true });

        this.db = open<User>({
            path: path.join(this.storePath, "users"),
            compression: true,
            encoding: "json",
        });
    }

    async createUser(record: CreateUserRecord): Promise<User> {
        const db = this.ensureDb();

        // Check if username exists
        const existing = Array.from(db.getRange())
            .map(entry => entry.value)
            .find(u => u.username.toLowerCase() === record.username.toLowerCase());

        if (existing) {
            throw new Error(`User with username ${record.username} already exists`);
        }

        const user: User = {
            id: randomUUID(),
            username: record.username,
            passwordHash: record.passwordHash,
            role: record.role,
            createdAt: record.createdAt || new Date()
        };

        await db.put(user.id, user);
        return user;
    }

    async findUserByUsername(username: string): Promise<User | undefined> {
        const db = this.ensureDb();
        const search = username.toLowerCase();

        // Full scan is fine as number of users shouldn't be massive
        for (const { value } of db.getRange()) {
            if (value.username.toLowerCase() === search) {
                return value;
            }
        }
        return undefined;
    }

    async findUserById(id: string): Promise<User | undefined> {
        const db = this.ensureDb();
        return db.get(id);
    }

    async listUsers(): Promise<User[]> {
        const db = this.ensureDb();
        const users: User[] = [];

        for (const { value } of db.getRange()) {
            users.push(value);
        }

        return users.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }

    private ensureDb(): Database<User> {
        if (!this.db) {
            throw new Error("User database is not initialized");
        }
        return this.db;
    }
}

let userRepository: UserRepository | null = null;
export function getUserRepository(storePath?: string): UserRepository {
    if (!userRepository) {
        if (!storePath) throw new Error("Store path required for initial LmdbUserRepository creation");
        userRepository = new LmdbUserRepository(storePath);
    }
    return userRepository;
}
