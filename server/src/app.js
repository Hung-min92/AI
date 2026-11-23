import express from "express";
import Project from "./models/Project.js";
import Task from "./models/Task.js";
import User from "./models/User.js";
import { createAuthRouter } from "./routes/auth.routes.js";
import { createProjectRouter } from "./routes/project.routes.js";

export function createApp({ authConfig, userModel = User, projectModel = Project, taskModel = Task } = {}) {
  const app = express();

  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      message: "AI Task Manager API is running",
    });
  });

  if (authConfig) {
    app.use("/api/auth", createAuthRouter(userModel, authConfig));
    app.use("/api/projects", createProjectRouter({ authConfig, userModel, projectModel, taskModel }));
  }

  app.use((req, res) => {
    res.status(404).json({ message: "Route not found" });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.too.large") {
      return res.status(413).json({ message: "Request body is too large." });
    }
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ message: "Invalid JSON body." });
    }
    if (error.status === 415) {
      return res.status(415).json({ message: "Unsupported request body format." });
    }
    return res.status(500).json({ message: "Internal server error." });
  });
  return app;
}

export default createApp();
