import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { before, test } from "node:test";
import { SignJWT } from "jose";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/config/auth.js";
import { hashPassword, verifyPassword } from "../src/services/password.service.js";
import { signAccessToken } from "../src/services/token.service.js";

const authConfig = loadAuthConfig({ JWT_SECRET: randomBytes(32).toString("base64") });
const password = randomBytes(20).toString("hex");
const userId = "507f1f77bcf86cd799439011";
const email = "minh@example.com";
const profile = { id: userId, name: "Minh", email };
let passwordHash;

before(async () => {
  passwordHash = await hashPassword(password);
});

function fakeUsers(initial = []) {
  const users = new Map(initial.map((user) => [user.email, user]));
  return {
    users,
    async create(fields) {
      if (users.has(fields.email)) throw Object.assign(new Error("Duplicate"), {
        code: 11000,
        keyPattern: { email: 1 },
      });
      users.set(fields.email, { ...fields, _id: userId });
    },
    findOne({ email }) {
      return {
        async select(fields) {
          assert.equal(fields, "name email +passwordHash");
          return users.get(email) ?? null;
        },
      };
    },
    findById(id) {
      return {
        async select(fields) {
          assert.equal(fields, "name email");
          return [...users.values()].find((user) => user._id === id) ?? null;
        },
      };
    },
  };
}

function seededUsers() {
  return fakeUsers([{ _id: userId, name: profile.name, email, passwordHash }]);
}

async function startAuthServer(t, userModel = fakeUsers()) {
  const server = createApp({ authConfig, userModel }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/auth`;
  return {
    post: (path, data) => fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    me: (token) => fetch(url + "/me", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  };
}

test("register creates a hashed account and returns the same response for a duplicate email", async (t) => {
  const model = fakeUsers();
  const { post } = await startAuthServer(t, model);
  const first = await post("/register", { name: " Minh ", email: " Minh@Example.com ", password });
  const duplicate = await post("/register", { name: "Other", email, password });

  for (const response of [first, duplicate]) {
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["message"]);
    assert.equal(body.message, "Registration request accepted.");
  }
  assert.equal(model.users.size, 1);
  const stored = model.users.get(email);
  assert.equal(stored?.name, "Minh");
  assert.ok(stored.passwordHash.startsWith("$argon2id$"));
  assert.equal(await verifyPassword(password, stored.passwordHash), true);
});

test("register and login reject invalid payloads and oversized JSON", async (t) => {
  const model = fakeUsers();
  const { post } = await startAuthServer(t, model);
  for (const [path, payload, status] of [
    ["/register", { name: "Minh", email: "invalid", password }, 400],
    ["/login", { email, password, userId }, 400],
    ["/register", { name: "x".repeat(17 * 1024), email, password }, 413],
  ]) {
    const response = await post(path, payload);
    assert.equal(response.status, status);
    await response.json();
  }
  assert.equal(model.users.size, 0);
});

test("login signs a 15-minute token and /me returns the current user without a hash", async (t) => {
  const { post, me } = await startAuthServer(t, seededUsers());
  const response = await post("/login", { email: " MINH@example.com ", password });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["accessToken", "expiresIn", "tokenType", "user"]);
  assert.equal(body.tokenType, "Bearer");
  assert.equal(body.expiresIn, 900);
  assert.ok(typeof body.accessToken === "string" && body.accessToken.length > 0);
  assert.deepEqual(Object.keys(body.user).sort(), ["email", "id", "name"]);
  assert.deepEqual(body.user, profile);

  const meResponse = await me(body.accessToken);
  assert.equal(meResponse.status, 200);
  const meBody = await meResponse.json();
  assert.deepEqual(Object.keys(meBody.user).sort(), ["email", "id", "name"]);
  assert.deepEqual(meBody, { user: profile });
});

test("wrong password and unknown email return identical 401 responses", async (t) => {
  const { post } = await startAuthServer(t, seededUsers());
  for (const input of [
    { email, password: password + "x" },
    { email: "unknown@example.com", password },
  ]) {
    const response = await post("/login", input);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "Invalid email or password." });
  }
});

test("/me rejects missing, expired, incorrectly signed or mis-scoped tokens", async (t) => {
  const { me } = await startAuthServer(t, seededUsers());
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setSubject(userId)
    .setIssuer(authConfig.issuer)
    .setAudience(authConfig.audience)
    .setIssuedAt(now - 901)
    .setExpirationTime(now - 1)
    .sign(authConfig.secret);

  for (const token of [
    undefined,
    expired,
    await signAccessToken(userId, { ...authConfig, secret: randomBytes(32) }),
    await signAccessToken(userId, { ...authConfig, issuer: "different-issuer" }),
    await signAccessToken(userId, { ...authConfig, audience: "different-audience" }),
    await signAccessToken("507f1f77bcf86cd799439012", authConfig),
  ]) {
    const response = await me(token);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await response.json(), { message: "Unauthorized." });
  }
});

test("register rate-limits requests by IP with 429 and Retry-After", async (t) => {
  const { post } = await startAuthServer(t);
  for (let i = 0; i < 11; i++) {
    const response = await post("/register", {});
    assert.equal(response.status, i < 10 ? 400 : 429);
    if (i === 10) assert.ok(Number(response.headers.get("retry-after")) > 0);
    await response.json();
  }
});

test("login rate-limits by normalized email before consulting the database", async (t) => {
  let lookups = 0;
  const { post } = await startAuthServer(t, {
    findOne() {
      lookups++;
      return { select: async () => null };
    },
  });
  for (let i = 0; i < 11; i++) {
    const response = await post("/login", {
      email: i % 2 ? " MINH@example.com " : email,
      password,
    });
    assert.equal(response.status, i < 10 ? 401 : 429);
    if (i === 10) assert.ok(Number(response.headers.get("retry-after")) > 0);
    await response.json();
  }
  assert.equal(lookups, 10);
});
