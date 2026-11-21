import mongoose from "mongoose";
import { z } from "zod";

const emailSchema = z.email();

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (value) => emailSchema.safeParse(value).success,
        message: "Invalid email address",
      },
    },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

export default mongoose.model("User", userSchema);
