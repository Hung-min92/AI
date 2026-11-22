import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { createAuthController } from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { createAuthService } from "../services/auth.service.js";
import { loginSchema, registerSchema } from "../validators/auth.schema.js";

const limitOptions = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many requests. Try again later." },
};

function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid request body." });
    res.locals.credentials = parsed.data;
    return next();
  };
}

export function createAuthRouter(userModel, authConfig) {
  const router = Router();
  const controller = createAuthController(createAuthService(userModel, authConfig));
  const registerByIp = rateLimit({ ...limitOptions, limit: 10 });
  const loginByIp = rateLimit({ ...limitOptions, limit: 30 });
  const loginByEmail = rateLimit({
    ...limitOptions,
    limit: 10,
    keyGenerator: (req, res) => res.locals.credentials.email,
  });

  router.post("/register", registerByIp, validate(registerSchema), controller.register);
  router.post("/login", loginByIp, validate(loginSchema), loginByEmail, controller.login);
  router.get("/me", authenticate(authConfig), controller.me);
  return router;
}
