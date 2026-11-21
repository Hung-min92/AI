import { verifyAccessToken } from "../services/token.service.js";

export function authenticate(authConfig) {
  return async (req, res, next) => {
    const token = req.get("Authorization")?.match(/^Bearer +([^\s,]+)$/i)?.[1];
    if (token) {
      let payload;
      try {
        payload = await verifyAccessToken(token, authConfig);
      } catch {
        return res.set("WWW-Authenticate", "Bearer").status(401).json({ message: "Unauthorized." });
      }
      req.user = { id: payload.sub };
      return next();
    }
    return res.set("WWW-Authenticate", "Bearer").status(401).json({ message: "Unauthorized." });
  };
}
