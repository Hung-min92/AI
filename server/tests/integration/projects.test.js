import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "../../src/app.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { configureDnsServers } from "../../src/config/db.js";
import Project from "../../src/models/Project.js";
import Task from "../../src/models/Task.js";
import User from "../../src/models/User.js";
import { signAccessToken } from "../../src/services/token.service.js";

const database = "ai_task_manager_test";
const connection = mongoose.createConnection();
const authConfig = loadAuthConfig({ JWT_SECRET: randomBytes(32).toString("base64") });
const makeId = () => new mongoose.Types.ObjectId();
const runId = randomUUID();
const name = "Project integration " + runId;
const owner = makeId();
const other = makeId();
const missing = makeId();
const owned = { _id: makeId(), owner, name: name + " owned" };
const foreign = { _id: makeId(), owner: other, name: name + " foreign" };
const createdName = name + " created";
const listName = name + " list";
const task = { _id: makeId(), project: owned._id, title: name };
const users = [
  { _id: owner, name, email: runId + "-a@example.com" },
  { _id: other, name, email: runId + "-b@example.com" },
];
const ownerFilter = { owner: { $in: [owner, other] } };
const projectFilter = { ...ownerFilter, name: { $in: [owned.name, foreign.name, createdName, listName] } };
let userModel, projectModel, taskModel, server, endpoint, token, otherToken;
let fixturesStarted = false;

function testUri() {
  let file = {};
  try { file = dotenv.parse(readFileSync(new URL("../../.env", import.meta.url))); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("Could not read local test configuration.");
  }
  const uri = (process.env.MONGODB_TEST_URI ?? file.MONGODB_TEST_URI)?.trim();
  if (!uri) throw new Error("MONGODB_TEST_URI is required.");
  let options;
  try { options = new mongoose.mongo.MongoClient(uri).options; }
  catch { throw new Error("Invalid MONGODB_TEST_URI format."); }
  const path = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]*)(?:[?#]|$)/)?.[1];
  if (path !== database || options.dbName !== database) {
    throw new Error("MONGODB_TEST_URI must explicitly target ai_task_manager_test.");
  }
  if (options.writeConcern?.w === 0) throw new Error("Test writes must be acknowledged.");
  const resolvers = (process.env.MONGODB_TEST_DNS_SERVERS ?? file.MONGODB_TEST_DNS_SERVERS)?.trim();
  if (resolvers && uri.startsWith("mongodb+srv://")) {
    try { configureDnsServers(resolvers.split(",").map(ip => ip.trim())); }
    catch { throw new Error("Invalid test DNS configuration."); }
  }
  return uri;
}

function verifyDatabase() {
  assert.ok(connection.db?.databaseName === database, "Unexpected connected database.");
}

async function safe(operation, action) {
  try { return await action(); }
  catch (error) {
    const allowed = [13, 18, 26, 50, 8000, 11000, "ECONNREFUSED", "ENOTFOUND", "ENODATA", "ETIMEOUT", "ETIMEDOUT"];
    const candidates = [error, error?.cause];
    for (const server of error?.reason?.servers?.values?.() ?? []) candidates.push(server.error, server.error?.cause);
    const code = candidates.find(item => allowed.includes(item?.code))?.code ?? "N/A";
    throw new Error(operation + " failed (code: " + code + ").");
  }
}

async function write(operation, action) {
  verifyDatabase();
  return safe(operation, action);
}

async function preflight(models) {
  const { authInfo } = await safe("Read test privileges", () =>
    connection.db.command({ connectionStatus: 1, showPrivileges: true }));
  const privileges = authInfo?.authenticatedUserPrivileges ?? [];
  assert.ok(privileges.length && privileges.every(({ resource }) =>
    resource?.db === database && !resource.anyResource && !resource.cluster),
  "Test credentials must be scoped to the test database.");
  for (const model of models) {
    const collection = model.collection.name;
    const required = model === projectModel ? ["find", "insert", "update", "remove"] : ["find", "insert", "remove"];
    assert.ok(required.every(action => privileges.some(({ resource, actions }) =>
      (resource.collection === "" || resource.collection === collection) &&
      (actions.includes(action) || actions.includes("anyAction")))),
    "Missing fixture permissions for " + collection);
    const indexes = await safe("Read " + collection + " indexes", () => model.listIndexes());
    for (const [key, options] of model.schema.indexes()) {
      assert.ok(indexes.some(index =>
        isDeepStrictEqual(Object.entries(index.key), Object.entries(key)) &&
        Boolean(index.unique) === Boolean(options.unique) && !index.sparse && !index.partialFilterExpression &&
        (!index.collation || index.collation.locale === "simple")),
      "Missing expected index for " + collection);
    }
  }
}

before(async (t) => {
  const uri = testUri();
  await safe("Connect to test database", () => connection.openUri(uri, {
    serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 15_000,
    autoCreate: false, autoIndex: false, readPreference: "primary",
  }));
  verifyDatabase();
  [userModel, projectModel, taskModel] = [User, Project, Task].map(model =>
    connection.model(model.modelName, model.schema, model.collection.name));
  await preflight([userModel, projectModel, taskModel]);
  assert.ok(!(await safe("Check User fixtures", () => userModel.exists({
    $or: [{ _id: { $in: [owner, other] } }, { email: { $in: users.map(user => user.email) } }],
  }))));
  assert.ok(!(await safe("Check Project fixtures", () => projectModel.exists({
    $or: [ownerFilter, { _id: { $in: [owned._id, foreign._id, missing] } }],
  }))));
  assert.ok(!(await safe("Check Task fixture", () => taskModel.exists({ _id: task._id }))));
  t.diagnostic("Verified ai_task_manager_test, scoped permissions, and required indexes before writes.");

  fixturesStarted = true;
  await write("Create User fixtures", () => userModel.create(
    users.map(user => ({ ...user, passwordHash: "integration-fixture" })), { ordered: true },
  ));
  await write("Create owned Project", () => projectModel.create({
    ...owned, createdAt: new Date("2020-01-01T00:00:00Z"),
  }));
  await write("Create foreign Project", () => projectModel.create(foreign));
  await write("Create linked Task", () => taskModel.create(task));
  token = await signAccessToken(String(owner), authConfig);
  otherToken = await signAccessToken(String(other), authConfig);

  server = createApp({ authConfig, userModel, projectModel, taskModel }).listen(0, "127.0.0.1");
  await safe("Start HTTP server", () => once(server, "listening"));
  endpoint = "http://127.0.0.1:" + server.address().port + "/api/projects";
});

after(async (t) => {
  const failures = [];
  async function attempt(action) {
    try { return await action(); }
    catch (error) { failures.push(error); }
  }
  try {
    if (server?.listening) await attempt(() => safe("Close HTTP server", () =>
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    if (fixturesStarted) {
      verifyDatabase();
      const rows = await attempt(() => safe("Find Project fixtures", () =>
        projectModel.find(projectFilter).select("_id owner name").lean()));
      const operations = [
        [taskModel, [task], { _id: task._id }],
        [projectModel, rows ?? [], ownerFilter],
        [userModel, users, { _id: { $in: [owner, other] } }],
      ];
      const deleted = {};
      for (const [model, filters, remainingFilter] of operations) {
        deleted[model.modelName] = 0;
        for (const filter of filters) {
          await attempt(async () => {
            const result = await write("Clean up " + model.modelName, () => model.deleteOne(filter));
            assert.ok(result.acknowledged, "Cleanup write was not acknowledged.");
            deleted[model.modelName] += result.deletedCount;
          });
        }
        await attempt(async () => {
          const remaining = await safe("Verify " + model.modelName + " cleanup", () => model.exists(remainingFilter));
          assert.ok(!remaining, model.modelName + " fixture remains.");
        });
      }
      if (!failures.length) t.diagnostic("Run " + runId + ": teardown deleted " + JSON.stringify(deleted) +
        " and confirmed no fixtures remain.");
    }
  } finally {
    await attempt(() => safe("Close test connection", () => connection.close()));
  }
  if (failures.length) throw new AggregateError(failures, "Cleanup failed for run " + runId + ".");
});

async function request(method, path = "", body, bearer = token) {
  if (method !== "GET") verifyDatabase();
  return safe("HTTP " + method, async () => {
    const headers = {};
    if (bearer) headers.Authorization = "Bearer " + bearer;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(endpoint + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return { status: response.status, location: response.headers.get("location"), body: raw ? JSON.parse(raw) : raw };
  });
}

test("Create, read, update, and delete persist for an owned Project", async () => {
  const created = await request("POST", "", { name: "  " + createdName + "  " });
  assert.equal(created.status, 201);
  const { project } = created.body;
  assert.match(project.id, /^[a-f0-9]{24}$/);
  assert.equal(created.location, "/api/projects/" + project.id);
  assert.deepEqual(Object.keys(project).sort(), ["createdAt", "description", "id", "name", "updatedAt"]);
  const read = () => safe("Read persisted Project", () => projectModel.findById(project.id).lean());
  const stored = await read();
  assert.ok(stored?.owner.equals(owner));
  assert.equal(stored.name, createdName);
  assert.equal(stored.description, "");
  assert.equal(project.createdAt, stored.createdAt.toISOString());
  assert.equal(project.updatedAt, stored.updatedAt.toISOString());
  const detail = await request("GET", "/" + project.id);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body, created.body);
  const update = await request("PATCH", "/" + project.id, { description: "Persisted update" });
  assert.equal(update.status, 200);
  const updated = await read();
  assert.ok(updated?.owner.equals(owner));
  assert.equal(updated.description, "Persisted update");
  assert.equal(update.body.project.description, updated.description);
  assert.equal(update.body.project.updatedAt, updated.updatedAt.toISOString());
  const deleted = await request("DELETE", "/" + project.id);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, "");
  assert.equal(await read(), null);
});

test("List paginates and sorts only Projects of the authenticated owner", async () => {
  const created = await request("POST", "", { name: listName });
  assert.equal(created.status, 201);
  const newest = created.body.project.id;
  const stored = await safe("Read list fixture", () => projectModel.findById(newest).lean());
  assert.ok(stored?.owner.equals(owner));
  for (const [query, expected] of [
    ["?page=1&limit=1&sort=newest", newest],
    ["?page=2&limit=1&sort=newest", String(owned._id)],
    ["?page=1&limit=1&sort=oldest", String(owned._id)],
  ]) {
    const response = await request("GET", query);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.projects.map(project => project.id), [expected]);
    assert.equal(response.body.pagination.total, 2);
  }
  const response = await request("GET", "", undefined, otherToken);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.projects.map(project => project.id), [String(foreign._id)]);
  assert.equal(response.body.pagination.total, 1);
});

test("Foreign and nonexistent Projects return identical 404 responses", async () => {
  for (const id of [foreign._id, missing]) {
    for (const [method, body] of [["GET"], ["PATCH", { description: "Rejected update" }], ["DELETE"]]) {
      const response = await request(method, "/" + id, body);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "Project not found." });
    }
  }
  const stored = await safe("Read foreign Project", () => projectModel.findById(foreign._id).lean());
  assert.ok(stored?.owner.equals(other));
  assert.equal(stored.description, "");
});

test("Delete returns 409 and retains both the Project and its linked Task", async () => {
  assert.equal((await request("DELETE", "/" + owned._id)).status, 409);
  assert.ok(await safe("Verify Project survives", () => projectModel.exists(owned)));
  assert.ok(await safe("Verify Task survives", () => taskModel.exists(task)));
});

test("JWT and input validation failures leave stored Projects intact", async () => {
  const wrong = await signAccessToken(String(owner), { ...authConfig, secret: randomBytes(32) });
  const count = () => safe("Count Project fixtures", () => projectModel.countDocuments(ownerFilter));
  const before = await count();
  for (const bearer of [null, wrong]) {
    for (const [method, path, body] of [
      ["POST", "", { name: createdName }], ["GET", ""], ["GET", "/" + owned._id],
      ["PATCH", "/" + owned._id, { description: "Rejected update" }], ["DELETE", "/" + owned._id],
    ]) {
      assert.equal((await request(method, path, body, bearer)).status, 401);
    }
  }
  for (const [method, path, body] of [
    ["GET", "/bad-id"], ["GET", "/%E0%A4%A"], ["GET", "?limit=101"],
    ["PATCH", "/bad-id", { description: "Rejected update" }], ["DELETE", "/bad-id"],
    ["POST", "", { name: "" }], ["POST", "", { name: createdName, owner: String(other) }],
    ["PATCH", "/" + owned._id, {}], ["PATCH", "/" + owned._id, { owner: String(other) }],
  ]) {
    assert.equal((await request(method, path, body)).status, 400);
  }
  assert.equal(await count(), before);
  const stored = await safe("Verify owned Project unchanged", () => projectModel.findById(owned._id).lean());
  assert.ok(stored?.owner.equals(owner));
  assert.equal(stored.description, "");
});
