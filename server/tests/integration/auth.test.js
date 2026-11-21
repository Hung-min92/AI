import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { SignJWT } from "jose";
import mongoose from "mongoose";
import { createApp } from "../../src/app.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { configureDnsServers } from "../../src/config/db.js";
import User from "../../src/models/User.js";
import { verifyPassword } from "../../src/services/password.service.js";
import { signAccessToken, verifyAccessToken } from "../../src/services/token.service.js";

const databaseName = "ai_task_manager_test";
const runId = randomUUID();
const name = `Auth integration ${runId}`;
const email = `auth-${runId}@example.com`;
const concurrentEmail = `auth-concurrent-${runId}@example.com`;
const passwords = { valid: randomBytes(24).toString("hex"), invalid: randomBytes(24).toString("hex") };
const authConfig = loadAuthConfig({ JWT_SECRET: randomBytes(32).toString("base64") });
const safeCodes = new Set([13, 18, 26, 8000, 11000, "ECONNREFUSED", "ECONNRESET",
  "ENOTFOUND", "ENODATA", "EAI_AGAIN", "ESERVFAIL", "ETIMEOUT", "ETIMEDOUT"]);
const attemptedEmails = new Set();
const connection = mongoose.createConnection();
let userModel;
let server;
let baseUrl;

function verifiedTestUri() {
  const uri = process.env.MONGODB_TEST_URI?.trim();
  if (!uri) throw new Error("MONGODB_TEST_URI is required.");

  let options;
  try {
    options = new mongoose.mongo.MongoClient(uri).options;
  } catch {
    throw new Error("MONGODB_TEST_URI is not a valid MongoDB connection string.");
  }
  const path = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]*)(?:[?#]|$)/)?.[1];
  if (path !== databaseName || options.dbName !== databaseName) {
    throw new Error(`MONGODB_TEST_URI must explicitly target ${databaseName}.`);
  }
  if (options.writeConcern?.w === 0) throw new Error("Test writes must be acknowledged.");
  return uri;
}

function verifyDatabase() {
  assert.ok(connection.db?.databaseName === databaseName, "Unexpected connected test database.");
}

async function safeOperation(operation, action) {
  try {
    return await action();
  } catch (error) {
    const candidates = [error, error?.cause];
    for (const reason of [error?.reason, error?.cause?.reason]) {
      for (const server of reason?.servers?.values?.() ?? []) {
        candidates.push(server.error, server.error?.cause);
      }
    }
    const code = candidates.find((candidate) => safeCodes.has(candidate?.code))?.code ?? "N/A";
    throw new Error(`${operation} failed (code: ${code}).`);
  }
}

async function verifyUserCollection() {
  const collection = userModel.collection.name;
  const indexes = await safeOperation("Read users indexes", async () => {
    try {
      return await userModel.listIndexes();
    } catch (error) {
      if (error.code === 26) return [];
      throw error;
    }
  });
  assert.ok(indexes.some((index) =>
    isDeepStrictEqual(index.key, { email: 1 }) && index.unique === true &&
    !index.sparse && !index.partialFilterExpression &&
    (!index.collation || index.collation.locale === "simple"),
  ), "Missing a full unique index on users.email.");

  const { authInfo } = await safeOperation("Verify test fixture permissions", () =>
    connection.db.command({ connectionStatus: 1, showPrivileges: true }));
  const roles = authInfo?.authenticatedUserRoles ?? [];
  const privileges = authInfo?.authenticatedUserPrivileges ?? [];
  const hasWriteRole = roles.some(({ db, role }) =>
    db === databaseName && ["readWrite", "dbOwner"].includes(role));
  const hasActions = ["find", "insert", "remove"].every((action) =>
    privileges.some(({ resource, actions }) =>
      (resource.anyResource ||
        ((resource.db === databaseName || resource.db === "") &&
         (resource.collection === collection || resource.collection === ""))) &&
      (actions.includes(action) || actions.includes("anyAction"))));
  assert.ok(hasWriteRole || hasActions, "Test account needs read, insert and remove access on users.");
}

before(async () => {
  const uri = verifiedTestUri();
  const resolvers = process.env.MONGODB_TEST_DNS_SERVERS?.trim();
  if (resolvers && uri.startsWith("mongodb+srv://")) {
    try {
      configureDnsServers(resolvers.split(",").map((value) => value.trim()));
    } catch {
      throw new Error("MONGODB_TEST_DNS_SERVERS must contain comma-separated DNS server IPs.");
    }
  }
  await safeOperation("Connect to test database", () => connection.openUri(uri, {
    serverSelectionTimeoutMS: 10_000,
    readPreference: "primary",
    autoCreate: false,
    autoIndex: false,
  }));
  verifyDatabase();
  userModel = connection.model("User", User.schema, User.collection.name);
  await verifyUserCollection();
  const existing = await safeOperation("Check fixture emails", () =>
    userModel.exists({ email: { $in: [email, concurrentEmail] } }));
  assert.ok(!existing, "A generated fixture email is already in use.");

  server = createApp({ authConfig, userModel }).listen(0, "127.0.0.1");
  await safeOperation("Start test HTTP server", () => once(server, "listening"));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
});

after(async (t) => {
  const failures = [];
  let deleted = 0;
  try {
    if (server?.listening) {
      try {
        await safeOperation("Close test HTTP server", () => new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }));
      } catch (error) {
        failures.push(error);
      }
    }
    if (attemptedEmails.size) {
      verifyDatabase();
      for (const email of attemptedEmails) {
        try {
          const filter = { email, name };
          const rows = await safeOperation("Find User fixtures", () => userModel.find(filter).select("_id").lean());
          for (const { _id } of rows) {
            const result = await safeOperation("Delete User fixture", () => userModel.deleteOne({ _id, ...filter }));
            assert.ok(result.acknowledged, "Fixture deletion was not acknowledged.");
            deleted += result.deletedCount;
          }
          const remaining = await safeOperation("Verify fixture cleanup", () => userModel.exists(filter));
          assert.ok(!remaining, "A fixture remains after cleanup.");
        } catch (error) {
          failures.push(error);
        }
      }
      if (!failures.length) t.diagnostic(`Run ${runId}: deleted ${deleted} User fixtures and verified cleanup.`);
    }
  } finally {
    await safeOperation("Close test database connection", () => connection.close());
  }
  if (failures.length) throw new AggregateError(failures, `Cleanup failed for run ${runId}.`);
});

async function request(path, body, token) {
  return safeOperation(`HTTP ${path}`, async () => {
    const response = await fetch(baseUrl + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } :
        token ? { Authorization: `Bearer ${token}` } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cacheControl: response.headers.get("cache-control"),
      json: await response.json() };
  });
}

function register(fixtureEmail) {
  verifyDatabase();
  attemptedEmails.add(fixtureEmail.trim().toLowerCase());
  return request("/register", { name, email: fixtureEmail, password: passwords.valid });
}

function assertRegistration(response) {
  assert.equal(response.status, 202);
  assert.ok(isDeepStrictEqual(response.json, { message: "Registration request accepted." }),
    "Register must return only its generic message.");
}

test("Register persists an Argon2id hash and duplicate registration returns the same 202", async () => {
  assertRegistration(await register(`  ${email.toUpperCase()}  `));
  assertRegistration(await register(email));
  const users = await safeOperation("Read registered User", () =>
    userModel.find({ email }).select("name email +passwordHash").lean());
  assert.equal(users.length, 1);
  const [user] = users;
  assert.ok(user.email === email && user.name === name, "Stored User does not match the fixture.");
  assert.ok(user.passwordHash?.startsWith("$argon2id$"), "Expected an Argon2id hash.");
  assert.ok(await safeOperation("Verify persisted password hash", () =>
    verifyPassword(passwords.valid, user.passwordHash)), "Stored password hash did not verify.");
});

test("Concurrent registration of equivalent emails persists only one User", async () => {
  const outcomes = await Promise.allSettled([
    register(concurrentEmail),
    register(`  ${concurrentEmail.toUpperCase()}  `),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
    assertRegistration(outcome.value);
  }
  const count = await safeOperation("Count concurrent User fixtures", () =>
    userModel.countDocuments({ email: concurrentEmail }));
  assert.equal(count, 1);
});

test("Login issues a valid JWT and /me returns the registered User", async () => {
  const user = await safeOperation("Read User profile fixture", () =>
    userModel.findOne({ email, name }).select("_id").lean());
  assert.ok(user, "Profile fixture was not found.");
  const profile = { id: String(user._id), email, name };

  const login = await request("/login", { email, password: passwords.valid });
  assert.equal(login.status, 200);
  assert.equal(login.cacheControl, "no-store");
  assert.ok(isDeepStrictEqual(Object.keys(login.json).sort(), ["accessToken", "expiresIn", "tokenType", "user"]));
  const { accessToken, expiresIn, tokenType } = login.json;
  assert.ok(typeof accessToken === "string" && tokenType === "Bearer" && expiresIn === 900);
  assert.ok(isDeepStrictEqual(login.json.user, profile), "Login returned an unexpected profile.");
  const payload = await safeOperation("Verify Login JWT", () => verifyAccessToken(accessToken, authConfig));
  assert.ok(payload.sub === profile.id && payload.exp - payload.iat === 900);

  const me = await request("/me", undefined, accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.cacheControl, "no-store");
  assert.ok(isDeepStrictEqual(me.json, { user: profile }), "/me returned an unexpected profile.");

  const invalidLogin = await request("/login", { email, password: passwords.invalid });
  assert.equal(invalidLogin.status, 401);
  assert.ok(isDeepStrictEqual(invalidLogin.json, { message: "Invalid email or password." }));

  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(authConfig.issuer).setAudience(authConfig.audience).setSubject(profile.id)
    .setIssuedAt(now - 901).setExpirationTime(now - 1).sign(authConfig.secret);
  const invalid = await signAccessToken(profile.id, { ...authConfig, secret: randomBytes(32) });
  for (const token of [undefined, invalid, expired]) {
    const response = await request("/me", undefined, token);
    assert.equal(response.status, 401);
    assert.ok(isDeepStrictEqual(response.json, { message: "Unauthorized." }));
  }
});
