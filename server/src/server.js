import { once } from "node:events";
import dotenv from "dotenv";
import { createApp } from "./app.js";
import { loadAuthConfig } from "./config/auth.js";
import { connectDb, disconnectDb } from "./config/db.js";

dotenv.config({ quiet: true });

const uri = process.env.MONGODB_URI?.trim();
const port = Number(process.env.PORT || 5000);
let httpServer;
let stopping = false;

async function closeDatabase() {
  try {
    await disconnectDb();
  } catch {
    console.error("Failed to close the MongoDB connection.");
    process.exitCode = 1;
  }
}

async function closeHttpAndDatabase() {
  try {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  } catch {
    console.error("Failed to close the HTTP server.");
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;

  // Startup handles cleanup when the signal arrives before HTTP is listening.
  if (httpServer) await closeHttpAndDatabase();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!uri?.match(/^mongodb(?:\+srv)?:\/\/\S+$/)) {
  console.error("MONGODB_URI must be a MongoDB connection string.");
  process.exitCode = 1;
} else if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exitCode = 1;
} else {
  let stage = "JWT configuration";

  try {
    const authConfig = loadAuthConfig();
    stage = "MongoDB connection";
    await connectDb(uri);
    if (stopping) {
      await closeDatabase();
    } else {
      stage = "HTTP startup";
      const app = createApp({ authConfig });
      const server = app.listen(port);
      await once(server, "listening");
      httpServer = server;
      if (stopping) {
        await closeHttpAndDatabase();
      } else {
        console.log(`Server running at http://localhost:${port}`);
      }
    }
  } catch {
    // Driver errors can include connection details, so log the stage only.
    console.error(stage === "JWT configuration"
      ? "JWT_SECRET must be valid Base64 encoding at least 32 bytes."
      : `Startup failed during ${stage}.`);
    process.exitCode = 1;
    if (stage !== "JWT configuration") await closeDatabase();
  }
}
