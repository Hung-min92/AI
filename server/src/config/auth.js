export function loadAuthConfig(env = process.env) {
  const encoded = env.JWT_SECRET;
  if (!encoded) throw new Error("JWT_SECRET is required.");

  const secret = Buffer.from(encoded, "base64");
  if (secret.length < 32 || secret.toString("base64") !== encoded) {
    throw new Error("JWT_SECRET must be canonical Base64 encoding at least 32 bytes.");
  }

  return {
    secret,
    issuer: "ai-task-manager",
    audience: "ai-task-manager-api",
  };
}
