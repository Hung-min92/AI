import mongoose from "mongoose";

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2000 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    taskLinkVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: true },
);

projectSchema.index({ owner: 1, createdAt: -1, _id: -1 });

export default mongoose.model("Project", projectSchema);
