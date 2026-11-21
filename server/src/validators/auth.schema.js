import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 15 && length <= 128;
}, "Password must contain 15 to 128 characters.");

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email,
  password,
});

export const loginSchema = z.strictObject({ email, password });
