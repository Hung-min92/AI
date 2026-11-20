import express from "express";

const app = express();

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "AI Task Manager API is running",
  });
});

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

export default app;
