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
const runId = randomUUID();
const marker = "Task integration " + runId;
const id = () => new mongoose.Types.ObjectId();
const owner = { _id: id(), name: marker, email: runId + "-owner@example.com" };
const other = { _id: id(), name: marker, email: runId + "-other@example.com" };
const absent = id();
const projects = Object.fromEntries(["crud", "foreign", "rollback", "createFirst", "deleteFirst"].map(key =>
  [key, { _id: id(), name: marker + " " + key, owner: key === "foreign" ? other._id : owner._id }]));
const projectIds = Object.values(projects).map(project => project._id);
const taskProjectFilter = { project: { $in: projectIds } };
const title = key => marker + " " + key;
const taskTitles = ["seed", "foreign", "crud", "invalid", "rollback", "createFirst", "deleteFirst"].map(title);
const seed = { title: title("seed"), project: projects.crud._id };
const foreignTask = { _id: id(), title: title("foreign"), project: projects.foreign._id };
let userModel, projectModel, taskModel, server, endpoint, token;
let fixturesStarted = false;

function readTestUri() {
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
  const name = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]*)(?:[?#]|$)/)?.[1];
  if (name !== database || options.dbName !== database) {
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
  assert.ok(connection.db?.databaseName === database, "Unexpected connected test database.");
}

async function safe(operation, action) {
  try { return await action(); }
  catch (error) {
    const allowed = [13, 18, 26, 50, 112, 8000, "ECONNREFUSED", "ENOTFOUND", "ENODATA", "ETIMEOUT", "ETIMEDOUT"];
    const candidates = [error, error?.cause];
    for (const reason of [error?.reason, error?.cause?.reason]) {
      for (const entry of reason?.servers?.values?.() ?? []) candidates.push(entry.error, entry.error?.cause);
    }
    const code = candidates.find(item => allowed.includes(item?.code))?.code ?? "N/A";
    throw new Error(operation + " failed (code: " + code + ").");
  }
}

async function write(operation, action) {
  verifyDatabase();
  return safe(operation, action);
}

async function preflight() {
  const { authInfo } = await safe("Read test account privileges", () =>
    connection.db.command({ connectionStatus: 1, showPrivileges: true }));
  const privileges = authInfo?.authenticatedUserPrivileges ?? [];
  assert.ok(authInfo?.authenticatedUsers?.length === 1 && privileges.length > 0 &&
    privileges.every(({ resource }) => resource?.db === database && !resource.anyResource && !resource.cluster),
  "Test account privileges could not be verified as scoped to ai_task_manager_test.");
  for (const model of [userModel, projectModel, taskModel]) {
    const collection = model.collection.name;
    const actions = model === userModel ? ["find", "insert", "remove"] : ["find", "insert", "update", "remove"];
    assert.ok(actions.every(action => privileges.some(privilege =>
      (privilege.resource.collection === "" || privilege.resource.collection === collection) &&
      (privilege.actions.includes(action) || privilege.actions.includes("anyAction")))),
    "Missing test permissions for " + collection + ".");
    const indexes = await safe("Read indexes for " + collection, () => model.listIndexes());
    for (const [key, options] of model.schema.indexes()) {
      assert.ok(indexes.some(index =>
        isDeepStrictEqual(Object.entries(index.key), Object.entries(key)) &&
        Boolean(index.unique) === Boolean(options.unique) && !index.sparse && !index.partialFilterExpression &&
        (!index.collation || index.collation.locale === "simple")),
      "Missing expected index for " + collection + ".");
    }
  }
}

before(async (t) => {
  const uri = readTestUri();
  await safe("Connect to test database", () => connection.openUri(uri, {
    serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 15_000,
    readPreference: "primary", autoCreate: false, autoIndex: false,
  }));
  verifyDatabase();
  [userModel, projectModel, taskModel] = [User, Project, Task].map(model =>
    connection.model(model.modelName, model.schema, model.collection.name));
  await preflight();
  assert.ok(!(await safe("Check User fixture identity", () => userModel.exists({
    $or: [{ _id: { $in: [owner._id, other._id] } }, { email: { $in: [owner.email, other.email] } }],
  }))), "User fixture collision.");
  assert.ok(!(await safe("Check Project fixture identity", () => projectModel.exists({
    _id: { $in: [...projectIds, absent] },
  }))), "Project fixture collision.");
  assert.ok(!(await safe("Check Task fixture identity", () => taskModel.exists({
    $or: [taskProjectFilter, { _id: { $in: [foreignTask._id, absent] } }],
  }))), "Task fixture collision.");
  t.diagnostic("Verified test database, scoped privileges, and required indexes before writing.");
  fixturesStarted = true;

  await write("Create User fixtures", () => userModel.create(
    [owner, other].map(user => ({ ...user, passwordHash: "fixture-placeholder" })), { ordered: true },
  ));
  await write("Create Project fixtures", () => projectModel.create(Object.values(projects), { ordered: true }));
  await write("Create Task fixtures", () => taskModel.create([
    { ...seed, createdAt: new Date("2020-01-01T00:00:00Z") }, foreignTask,
  ], { ordered: true }));

  token = await signAccessToken(String(owner._id), authConfig);
  server = createApp({ authConfig, userModel, projectModel, taskModel }).listen(0, "127.0.0.1");
  await safe("Start Task HTTP server", () => once(server, "listening"));
  endpoint = "http://127.0.0.1:" + server.address().port + "/api";
});

after(async (t) => {
  const failures = [];
  async function attempt(action) {
    try { return await action(); }
    catch (error) { failures.push(error); }
  }
  try {
    if (server?.listening) {
      await attempt(() => safe("Close HTTP server", () => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      })));
    }
    if (fixturesStarted) {
      verifyDatabase();
      const tasks = await attempt(() => safe("Find Task fixture IDs", () => taskModel.find({
        ...taskProjectFilter, title: { $in: taskTitles },
      }).select("_id project title").lean()));
      const operations = [
        [taskModel, tasks ?? [], taskProjectFilter],
        [projectModel, Object.values(projects), { _id: { $in: projectIds } }],
        [userModel, [owner, other], { _id: { $in: [owner._id, other._id] } }],
      ];
      const removed = {};
      for (const [model, filters, remaining] of operations) {
        removed[model.modelName] = 0;
        for (const filter of filters) {
          await attempt(async () => {
            const result = await write("Delete " + model.modelName + " fixture", () => model.deleteOne(filter));
            assert.ok(result.acknowledged, "Fixture delete was not acknowledged.");
            removed[model.modelName] += result.deletedCount;
          });
        }
        const clean = await attempt(async () => {
          assert.ok(!(await safe("Verify " + model.modelName + " cleanup", () => model.exists(remaining))),
            model.modelName + " fixtures remain.");
          return true;
        });
        if (!clean) break; // Preserve parents if child cleanup could not be confirmed.
      }
      if (!failures.length) t.diagnostic("Run " + runId + " removed " + JSON.stringify(removed) +
        " and confirmed no fixtures remain.");
    }
  } finally {
    await attempt(() => safe("Close test database connection", () => connection.close()));
  }
  if (failures.length) throw new AggregateError(failures, "Cleanup failed for run " + runId + ".");
});

const nested = project => "/projects/" + project._id + "/tasks";
const detail = taskId => "/tasks/" + taskId;
const projectPath = project => "/projects/" + project._id;

async function request(method, path, body, bearer = token) {
  if (method !== "GET") verifyDatabase();
  return safe("Task HTTP " + method, async () => {
    const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(endpoint + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return { status: response.status, location: response.headers.get("location"), body: raw ? JSON.parse(raw) : raw };
  });
}

function readTask(taskId) {
  return safe("Read persisted Task", () => taskModel.findById(taskId).lean());
}

function readProject(project) {
  return safe("Read persisted Project", () => projectModel.findById(project._id).select("+taskLinkVersion").lean());
}

function countTasks(project) {
  return safe("Count related Tasks", () => taskModel.countDocuments({ project: project._id }));
}

test("Task CRUD persists through HTTP, with scoped pagination and sorting", async () => {
  const project = projects.crud;
  const created = await request("POST", nested(project), {
    title: " " + title("crud") + " ", dueDate: "2026-12-01T09:00:00+07:00",
  });
  assert.equal(created.status, 201);
  const { task } = created.body;
  assert.equal(created.location, "/api" + detail(task.id));
  const stored = await readTask(task.id);
  assert.ok(stored?.project.equals(project._id));
  assert.equal(stored.title, title("crud"));
  assert.equal(stored.status, "todo");
  assert.equal(stored.priority, "medium");
  assert.equal(stored.dueDate.toISOString(), "2026-12-01T02:00:00.000Z");
  assert.equal((await readProject(project)).taskLinkVersion, 1);

  for (const [query, expectedTitle] of [
    ["?limit=1&sort=newest", title("crud")],
    ["?page=2&limit=1&sort=newest", seed.title],
    ["?limit=1&sort=oldest", seed.title],
  ]) {
    const list = await request("GET", nested(project) + query);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.tasks.map(row => row.title), [expectedTitle]);
    assert.equal(list.body.pagination.total, 2);
  }
  const fetched = await request("GET", detail(task.id));
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body.task, task);
  const patched = await request("PATCH", detail(task.id), { status: "done", dueDate: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.task.status, "done");
  const updated = await readTask(task.id);
  assert.equal(updated.status, "done");
  assert.equal(updated.dueDate, null);
  assert.ok(updated.project.equals(project._id));
  const deleted = await request("DELETE", detail(task.id));
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, "");
  assert.equal(await readTask(task.id), null);
});

test("JWT and ownership checks hide foreign and missing resources", async () => {
  const invalid = await signAccessToken(String(owner._id), { ...authConfig, secret: randomBytes(32) });
  for (const bearer of [null, invalid]) {
    for (const [method, path, body] of [
      ["POST", nested(projects.crud), { title: title("invalid") }], ["GET", nested(projects.crud)],
      ["GET", detail(foreignTask._id)], ["PATCH", detail(foreignTask._id), { status: "done" }],
      ["DELETE", detail(foreignTask._id)],
    ]) assert.equal((await request(method, path, body, bearer)).status, 401);
  }
  for (const project of [projects.foreign, { _id: absent }]) {
    for (const [method, body] of [["GET"], ["POST", { title: title("invalid") }]]) {
      const result = await request(method, nested(project), body);
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { message: "Project not found." });
    }
  }
  for (const taskId of [foreignTask._id, absent]) {
    for (const [method, body] of [["GET"], ["PATCH", { status: "done" }], ["DELETE"]]) {
      const result = await request(method, detail(taskId), body);
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { message: "Task not found." });
    }
  }
  assert.equal((await readTask(foreignTask._id)).status, "todo");
  assert.equal(await countTasks(projects.foreign), 1);
  assert.equal((await readProject(projects.foreign)).taskLinkVersion, 0);
});

test("Invalid params, body, and queries return 400 without persisting changes", async () => {
  const project = projects.crud;
  const found = await safe("Read seeded Task ID", () => taskModel.findOne(seed).select("_id").lean());
  const before = await countTasks(project);
  for (const [method, path, body] of [
    ["GET", "/projects/bad/tasks"], ["GET", "/tasks/%E0%A4%A"], ["GET", nested(project) + "?limit=101"],
    ["GET", nested(project) + "?page=1&page=2"],
    ["POST", nested(project), { title: "" }], ["POST", nested(project), { title: title("invalid"), dueDate: "2026-12-01" }],
    ["POST", nested(project), { title: title("invalid"), projectId: String(projects.foreign._id) }],
    ["PATCH", detail(found._id), {}], ["PATCH", detail(found._id), { owner: String(other._id) }],
    ["PATCH", detail(found._id), { project: String(projects.foreign._id) }],
  ]) assert.equal((await request(method, path, body)).status, 400);
  assert.equal(await countTasks(project), before);
  assert.ok((await readTask(found._id)).project.equals(project._id));
});

test("Delete Project returns 409 and rolls back its coordination write when a Task exists", async () => {
  const project = projects.crud;
  const before = await readProject(project);
  assert.equal((await request("DELETE", projectPath(project))).status, 409);
  const after = await readProject(project);
  assert.equal(after.taskLinkVersion, before.taskLinkVersion);
  assert.ok(await safe("Verify Task survived Project deletion", () => taskModel.exists(seed)));
});

test("Failure after a real Task insert rolls back both the Task and the Project touch", async (t) => {
  const project = projects.rollback;
  const create = taskModel.create;
  let insertedInsideTransaction = false;
  t.mock.method(taskModel, "create", async function (docs, options) {
    const result = await create.call(this, docs, options);
    assert.ok(options.session.inTransaction());
    insertedInsideTransaction = Boolean(await this.exists({ _id: result[0]._id }).session(options.session));
    throw new Error("Injected failure after insert.");
  });
  assert.equal((await request("POST", nested(project), { title: title("rollback") })).status, 500);
  assert.ok(insertedInsideTransaction, "The injected failure must occur after a visible insert in the session.");
  assert.equal(await countTasks(project), 0);
  assert.equal((await readProject(project)).taskLinkVersion, 0);
});

async function bounded(promise, description) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(description + " timed out.")), 12_000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

async function exerciseRace(t, project, firstMethod, winnerRequest, loserRequest) {
  const winnerReady = Promise.withResolvers();
  const releaseWinner = Promise.withResolvers();
  const winnerFinished = Promise.withResolvers();
  const firstConflict = Promise.withResolvers();
  const updateOne = projectModel.updateOne;
  let winnerSession, competingAttempts = 0, transientConflicts = 0;
  t.mock.method(projectModel, "updateOne", async function (filter, update, options) {
    if (String(filter._id) !== String(project._id)) return updateOne.call(this, filter, update, options);
    if (!winnerSession) winnerSession = options.session;
    if (options.session === winnerSession) return updateOne.call(this, filter, update, options);

    competingAttempts++;
    // After a real conflict, let the retry begin its first DB operation after the winner commits.
    if (competingAttempts > 1) await bounded(winnerFinished.promise, "Winner completion");
    try {
      return await updateOne.call(this, filter, update, options);
    } catch (error) {
      if (error.hasErrorLabel?.("TransientTransactionError")) {
        transientConflicts++;
        firstConflict.resolve();
      }
      throw error;
    }
  });

  const [model, method] = firstMethod === "create"
    ? [taskModel, "create"]
    : [projectModel, "deleteOne"];
  const original = model[method];
  t.mock.method(model, method, async function (...args) {
    const result = await original.apply(this, args);
    if (args[1]?.session === winnerSession) {
      winnerReady.resolve();
      await bounded(releaseWinner.promise, "Release of first transaction");
    }
    return result;
  });

  let first, second;
  try {
    first = winnerRequest().finally(() => winnerFinished.resolve());
    // Attach a handler immediately so a failed setup cannot cause an unhandled rejection.
    first.catch(() => {});
    await bounded(Promise.race([winnerReady.promise, first.then(() => {
      throw new Error("First request completed before reaching its transaction barrier.");
    })]), "First transaction barrier");
    second = loserRequest();
    second.catch(() => {});
    await bounded(Promise.race([firstConflict.promise, second.then(() => {
      throw new Error("Second request completed without a transient write conflict.");
    })]), "MongoDB transient conflict");
    releaseWinner.resolve();
    const results = await Promise.all([first, second]);
    assert.ok(transientConflicts >= 1 && competingAttempts >= 2, "Expected a real MongoDB conflict and retry.");
    return results;
  } finally {
    releaseWinner.resolve();
    await Promise.allSettled([first, second]);
  }
}

test("Create commits first: competing Project deletion retries and returns 409", async (t) => {
  const project = projects.createFirst;
  const [created, rejected] = await exerciseRace(t, project, "create",
    () => request("POST", nested(project), { title: title("createFirst") }),
    () => request("DELETE", projectPath(project)));
  assert.equal(created.status, 201);
  assert.equal(rejected.status, 409);
  assert.equal((await readProject(project)).taskLinkVersion, 1);
  assert.ok((await readTask(created.body.task.id)).project.equals(project._id));
  assert.equal(await countTasks(project), 1);
});

test("Delete commits first: competing Task creation retries and returns 404 without an orphan", async (t) => {
  const project = projects.deleteFirst;
  const [deleted, rejected] = await exerciseRace(t, project, "delete",
    () => request("DELETE", projectPath(project)),
    () => request("POST", nested(project), { title: title("deleteFirst") }));
  assert.equal(deleted.status, 204);
  assert.equal(rejected.status, 404);
  assert.equal(await readProject(project), null);
  assert.equal(await countTasks(project), 0);
});

test("No Task fixture points to a missing Project before teardown", async () => {
  const tasks = await safe("Find Task references for this run", () =>
    taskModel.find(taskProjectFilter).select("project").lean());
  for (const task of tasks) {
    assert.ok(await safe("Verify fixture Project reference", () => projectModel.exists({ _id: task.project })));
  }
});
