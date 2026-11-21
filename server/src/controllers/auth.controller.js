export function createAuthController(service) {
  return {
    async register(req, res) {
      await service.register(res.locals.credentials);
      return res.status(202).json({ message: "Registration request accepted." });
    },

    async login(req, res) {
      const result = await service.login(res.locals.credentials);
      if (!result) return res.status(401).json({ message: "Invalid email or password." });

      return res.set("Cache-Control", "no-store").json(result);
    },

    async me(req, res) {
      const user = await service.getProfile(req.user.id);
      if (!user) {
        return res.set("WWW-Authenticate", "Bearer").status(401).json({ message: "Unauthorized." });
      }
      return res.set("Cache-Control", "no-store").json({ user });
    },
  };
}
