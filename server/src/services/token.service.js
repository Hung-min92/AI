import { SignJWT, jwtVerify } from "jose";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ALGORITHM = "HS256";
const TYPE = "at+jwt";
const OBJECT_ID = /^[0-9a-f]{24}$/i;

export async function signAccessToken(userId, { secret, issuer, audience }) {
  if (typeof userId !== "string" || !OBJECT_ID.test(userId)) {
    throw new Error("Invalid access token subject.");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, typ: TYPE })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secret);
}

export async function verifyAccessToken(token, { secret, issuer, audience }) {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: [ALGORITHM],
    typ: TYPE,
    issuer,
    audience,
    requiredClaims: ["sub", "iat", "exp"],
    maxTokenAge: ACCESS_TOKEN_TTL_SECONDS,
  });

  if (typeof payload.sub !== "string" || !OBJECT_ID.test(payload.sub) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error("Invalid access token claims.");
  }

  return payload;
}
