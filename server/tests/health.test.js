import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import app from "../src/app.js";

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("GET /api/health returns HTTP 200", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  await response.arrayBuffer();

  assert.equal(response.status, 200);
});

test("GET /api/health returns the expected JSON body", async () => {
  const response = await fetch(`${baseUrl}/api/health`);

  assert.match(response.headers.get("content-type"), /^application\/json\b/);
  assert.deepEqual(await response.json(), {
    status: "ok",
    message: "AI Task Manager API is running",
  });
});

test("GET an unknown endpoint returns a JSON 404", async () => {
  const response = await fetch(`${baseUrl}/api/unknown`);

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /^application\/json\b/);
  assert.deepEqual(await response.json(), { message: "Route not found" });
});
