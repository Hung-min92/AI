import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

async function startStubbedServer(rejectDisconnect) {
  const { default: mongoose } = await import("mongoose");
  const { Server } = await import("node:net");

  mongoose.connect = async () => {};
  mongoose.disconnect = async () => {
    console.log("MongoDB disconnect called");
    if (rejectDisconnect) {
      throw Object.assign(new Error("sensitive-message-marker"), {
        name: "sensitive-name-marker",
        code: "sensitive-code-marker",
      });
    }
  };

  // Keep the real HTTP lifecycle, but let the OS choose a free loopback port.
  const listen = Server.prototype.listen;
  Server.prototype.listen = function () {
    this.once("close", () => console.log("HTTP server closed"));
    return listen.call(this, 0, "127.0.0.1");
  };

  await import("./src/server.js");
  // Emit the registered signals in-process so the test works on Windows.
  process.emit("SIGTERM");
  process.emit("SIGINT");
}

function runShutdown(rejectDisconnect) {
  const script = "(" + startStubbedServer.toString() + ")(" + rejectDisconnect + ");";
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      MONGODB_URI: "mongodb://127.0.0.1:1/shutdown_test",
      PORT: "5000",
      JWT_SECRET: randomBytes(32).toString("base64"),
    },
  });

  assert.ok(!child.error, "Shutdown subprocess did not complete.");
  assert.equal(child.signal, null);
  assert.deepEqual(child.stdout.trim().split(/\r?\n/).slice(1), [
    "HTTP server closed",
    "MongoDB disconnect called",
  ]);
  return child;
}

test("graceful shutdown closes HTTP and disconnects MongoDB once with exit code 0", () => {
  const child = runShutdown(false);
  assert.equal(child.status, 0);
  assert.ok(child.stderr.trim() === "", "Successful shutdown unexpectedly logged an error.");
});

test("MongoDB disconnect rejection is handled safely and the process exits with code 1", () => {
  const child = runShutdown(true);
  assert.equal(child.status, 1);
  assert.ok(child.stderr.trim() === "Failed to close the MongoDB connection.",
    "Expected only the safe shutdown diagnostic.");
});
