import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SignJWT } from "jose";
import { loadAuthConfig } from "../src/config/auth.js";
import { hashPassword, verifyPassword } from "../src/services/password.service.js";
import { signAccessToken, verifyAccessToken } from "../src/services/token.service.js";
import { loginSchema, registerSchema } from "../src/validators/auth.schema.js";

const password = ` ${randomBytes(20).toString("hex")} `;
const config = loadAuthConfig({ JWT_SECRET: randomBytes(32).toString("base64") });
const userId = "507f1f77bcf86cd799439011";

test("registration validates name and normalizes a valid email", () => {
  const result = registerSchema.parse({ name: "  Minh ", email: "  Minh+Tag@Example.com ", password });
  assert.equal(result.name, "Minh");
  assert.equal(result.email, "minh+tag@example.com");
  assert.ok(result.password === password, "Validation must preserve whitespace.");
  assert.equal(registerSchema.safeParse({ name: " ", email: result.email, password }).success, false);
});

test("registration and login reject invalid emails", () => {
  const credentials = { email: "invalid-email", password };
  assert.equal(loginSchema.safeParse(credentials).success, false);
  assert.equal(registerSchema.safeParse({ name: "Minh", ...credentials }).success, false);
});

test("registration and login enforce 15–128 Unicode characters for passwords", () => {
  for (const [length, accepted] of [[14, false], [15, true], [128, true], [129, false]]) {
    const credentials = { email: "minh@example.com", password: "🔑".repeat(length) };
    assert.equal(loginSchema.safeParse(credentials).success, accepted);
    assert.equal(registerSchema.safeParse({ name: "Minh", ...credentials }).success, accepted);
  }
});

test("auth schemas reject fields outside their contract", () => {
  const credentials = { email: "minh@example.com", password };
  assert.equal(registerSchema.safeParse({ name: "Minh", ...credentials, passwordHash: "extra" }).success, false);
  assert.equal(loginSchema.safeParse({ ...credentials, owner: userId }).success, false);
});

test("Argon2id hashes use the agreed costs and unique salts and verify the correct password", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.ok(first.startsWith("$argon2id$") && first.includes("$m=19456,t=2,p=1$"));
  assert.ok(first !== second, "Two hashes should use different salts.");
  assert.equal(await verifyPassword(password, first), true);
});

test("Argon2id verification rejects the wrong password", async () => {
  const digest = await hashPassword(password);
  assert.equal(await verifyPassword(password.trim(), digest), false);
});

test("a valid JWT has the expected claims and a 15-minute lifetime", async () => {
  const token = await signAccessToken(userId, config);
  const payload = await verifyAccessToken(token, config);
  assert.equal(payload.sub, userId);
  assert.equal(payload.iss, config.issuer);
  assert.equal(payload.aud, config.audience);
  assert.equal(payload.exp - payload.iat, 900);
});

test("verification rejects expired JWTs", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setSubject(userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(now - 901)
    .setExpirationTime(now - 1)
    .sign(config.secret);

  await assert.rejects(verifyAccessToken(token, config), { code: "ERR_JWT_EXPIRED" });
});

test("verification rejects a JWT with the wrong signature", async () => {
  const token = await signAccessToken(userId, config);
  await assert.rejects(
    verifyAccessToken(token, { ...config, secret: randomBytes(32) }),
    { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" },
  );
});

test("verification rejects a JWT with the wrong issuer", async () => {
  const token = await signAccessToken(userId, config);
  await assert.rejects(verifyAccessToken(token, { ...config, issuer: "another-issuer" }), {
    code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    claim: "iss",
  });
});

test("verification rejects a JWT with the wrong audience", async () => {
  const token = await signAccessToken(userId, config);
  await assert.rejects(verifyAccessToken(token, { ...config, audience: "another-api" }), {
    code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    claim: "aud",
  });
});

test("auth configuration fails when JWT_SECRET is missing or invalid", () => {
  assert.throws(() => loadAuthConfig({}), /JWT_SECRET is required/);
  for (const invalid of ["%%%", randomBytes(32).toString("base64") + "\n", randomBytes(31).toString("base64")]) {
    assert.throws(() => loadAuthConfig({ JWT_SECRET: invalid }), /Base64 encoding at least 32 bytes/);
  }
  assert.equal(config.secret.length, 32);
});
