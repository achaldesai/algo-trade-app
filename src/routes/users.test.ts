import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { EventEmitter, once } from "node:events";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createRequest, createResponse } from "node-mocks-http";
import errorHandler from "../middleware/errorHandler";
import usersRouter from "./users";
import env from "../config/env";
import type { AppContainer } from "../container";

interface StoredUser {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  createdAt: Date;
}

const users: StoredUser[] = [];

const mockUserRepo = {
  listUsers: () => [...users],
  findUserByUsername: (username: string) => users.find((u) => u.username === username),
  findUserById: (id: string) => users.find((u) => u.id === id),
  createUser: async (record: { username: string; passwordHash: string; role: string }) => {
    const user = { id: `user-${users.length + 1}`, createdAt: new Date(), ...record };
    users.push(user);
    return user;
  },
};

const testApp = express();
testApp.use(express.json());
testApp.locals.container = { userRepo: mockUserRepo } as unknown as AppContainer;
testApp.use("/api/users", usersRouter);
testApp.use(errorHandler);

const register = async (body: unknown, token?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const req = createRequest({ method: "POST", url: "/api/users/register", headers });
  req.body = body;
  const res = createResponse({ eventEmitter: EventEmitter });
  const waitForEnd = once(res, "end");
  testApp(req, res);
  req.emit("end");
  await waitForEnd;
  return res;
};

const tokenFor = (user: StoredUser) =>
  jwt.sign({ userId: user.id, role: user.role }, env.adminApiKey);

describe("POST /api/users/register", () => {
  const original = { nodeEnv: env.nodeEnv, adminApiKey: env.adminApiKey };

  beforeEach(() => {
    users.length = 0;
    env.adminApiKey = "test-secret";
    env.nodeEnv = "development";
  });

  afterEach(() => {
    env.nodeEnv = original.nodeEnv;
    env.adminApiKey = original.adminApiKey;
  });

  it("makes the first user an ADMIN", async () => {
    const res = await register({ username: "owner", password: "password123" });
    assert.equal(res.statusCode, 201);
    assert.equal(res._getJSONData().data.role, "ADMIN");
  });

  it("rejects an unauthenticated request for the ADMIN role", async () => {
    await register({ username: "owner", password: "password123" });
    const res = await register({ username: "attacker", password: "password123", role: "ADMIN" });
    assert.equal(res.statusCode, 403);
    assert.equal(users.length, 1);
  });

  it("creates a USER for unauthenticated signup in development", async () => {
    await register({ username: "owner", password: "password123" });
    const res = await register({ username: "bob", password: "password123" });
    assert.equal(res.statusCode, 201);
    assert.equal(res._getJSONData().data.role, "USER");
  });

  it("closes unauthenticated signup in production after bootstrap", async () => {
    env.nodeEnv = "production";
    await register({ username: "owner", password: "password123" });
    const res = await register({ username: "bob", password: "password123" });
    assert.equal(res.statusCode, 403);
    assert.equal(users.length, 1);
  });

  it("lets an ADMIN create another ADMIN", async () => {
    env.nodeEnv = "production";
    await register({ username: "owner", password: "password123" });
    const res = await register(
      { username: "second", password: "password123", role: "ADMIN" },
      tokenFor(users[0]),
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res._getJSONData().data.role, "ADMIN");
  });

  it("does not let a USER token create an ADMIN", async () => {
    await register({ username: "owner", password: "password123" });
    await register({ username: "bob", password: "password123" });
    const res = await register(
      { username: "eve", password: "password123", role: "ADMIN" },
      tokenFor(users[1]),
    );
    assert.equal(res.statusCode, 403);
  });

  it("ignores a token signed with the wrong secret", async () => {
    await register({ username: "owner", password: "password123" });
    const forged = jwt.sign({ userId: users[0].id, role: "ADMIN" }, "wrong-secret");
    const res = await register({ username: "eve", password: "password123", role: "ADMIN" }, forged);
    assert.equal(res.statusCode, 403);
  });
});
