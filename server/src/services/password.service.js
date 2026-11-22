import { randomBytes } from "node:crypto";
import { argon2id, hash, verify } from "argon2";

const memoryCost = 19 * 1024;
const timeCost = 2;
const parallelism = 1;
// A synthetic, valid PHC record makes unknown accounts pay the same verification cost.
const salt = randomBytes(16).toString("base64").replace(/=+$/, "");
const digest = randomBytes(32).toString("base64").replace(/=+$/, "");
const dummyHash = `$argon2id$v=19$m=${memoryCost},t=${timeCost},p=${parallelism}$${salt}$${digest}`;

export function hashPassword(password) {
  return hash(password, {
    type: argon2id,
    memoryCost,
    timeCost,
    parallelism,
  });
}

export async function verifyPassword(password, passwordHash) {
  const hasHash = passwordHash?.startsWith("$argon2id$");
  const matches = await verify(hasHash ? passwordHash : dummyHash, password);
  return Boolean(hasHash && matches);
}
