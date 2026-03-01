export type UserRole = "ADMIN" | "USER";

export interface User {
    id: string;
    username: string;
    passwordHash: string;
    role: UserRole;
    createdAt: Date;
}

export interface AuthSession {
    userId: string;
    token: string;
    expiresAt: Date;
}

export interface CreateUserRecord {
    username: string;
    passwordHash: string;
    role: UserRole;
    createdAt?: Date;
}
