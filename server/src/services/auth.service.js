import { hashPassword, verifyPassword } from "./password.service.js";
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from "./token.service.js";

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}

export function createAuthService(userModel, authConfig) {
  return {
    async register({ name, email, password }) {
      const passwordHash = await hashPassword(password);
      try {
        await userModel.create({ name, email, passwordHash });
      } catch (error) {
        const keys = Object.keys(error.keyPattern ?? {});
        if (error.code !== 11000 || keys.length !== 1 || keys[0] !== "email") throw error;
      }
    },

    async login({ email, password }) {
      const user = await userModel.findOne({ email }).select("name email +passwordHash");
      if (!(await verifyPassword(password, user?.passwordHash)) || !user) return null;

      const profile = publicUser(user);
      return {
        accessToken: await signAccessToken(profile.id, authConfig),
        tokenType: "Bearer",
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: profile,
      };
    },

    async getProfile(id) {
      const user = await userModel.findById(id).select("name email");
      return user ? publicUser(user) : null;
    },
  };
}
