import express from "express";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "AI Task Manager API is running",
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});