import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/config/auth.js";
import { signAccessToken } from "../src/services/token.service.js";

const authConfig = loadAuthConfig({ JWT_SECRET: randomBytes(32).toString("base64") });
const objectId = n => n.toString(16).padStart(24, "0");
const [owner, other, missing, project, foreignProject, firstTask, secondTask, foreignTask] =
  [1, 2, 3, 4, 5, 6, 7, 8].map(objectId);
const stamp = new Date("2026-01-01T00:00:00Z");
const nested = "/projects/" + project + "/tasks";
const detail = "/tasks/" + firstTask;
const keys = ["createdAt", "description", "dueDate", "id", "priority", "projectId", "status", "title", "updatedAt"];

function taskRow(_id, project, fields = {}) {
  return {
    _id, project, title: "Task", description: "", status: "todo", priority: "medium", dueDate: null,
    createdAt: stamp, updatedAt: stamp, ...fields,
  };
}

async function setup(t, { insertErrors = [], commitErrors = [] } = {}) {
  const rows = [taskRow(firstTask, project), taskRow(secondTask, project), taskRow(foreignTask, foreignProject)];
  const projects = [
    { _id: project, owner, taskLinkVersion: 0 },
    { _id: foreignProject, owner: other, taskLinkVersion: 0 },
  ];
  const calls = [];
  const transactionEvents = [];
  const insertedIds = [];
  const db = mongoose.createConnection();
  let activeSession;

  db.startSession = async () => {
    // Run the real driver retry loop with no socket and a local rollback snapshot.
    const session = new mongoose.mongo.MongoClient("mongodb://127.0.0.1:1").startSession();
    activeSession = session;
    const start = session.startTransaction.bind(session);
    const abort = session.abortTransaction.bind(session);
    const commit = session.commitTransaction.bind(session);
    let savedRows, savedProjects;
    session.startTransaction = options => {
      savedRows = rows.map(row => ({ ...row }));
      savedProjects = projects.map(row => ({ ...row }));
      transactionEvents.push("start");
      start(options);
    };
    session.abortTransaction = async () => {
      await abort();
      rows.splice(0, rows.length, ...savedRows);
      projects.splice(0, projects.length, ...savedProjects);
      transactionEvents.push("abort");
    };
    session.commitTransaction = async () => {
      transactionEvents.push("commit");
      if (commitErrors.length) throw commitErrors.shift();
      await commit();
    };
    return session;
  };
  const checkSession = (session) => {
    assert.equal(session, activeSession);
    assert.ok(session.inTransaction());
  };
  const matches = (row, filter) => Object.entries(filter).every(([field, value]) => row[field] === value);
  const query = row => ({ select: () => ({ lean: async () => row ?? null }) });
  const scoped = filter => assert.deepEqual(Object.keys(filter).sort(), ["_id", "project"]);
  const projectModel = {
    db,
    async exists(filter) {
      assert.deepEqual(Object.keys(filter).sort(), ["_id", "owner"]);
      return projects.some(row => matches(row, filter));
    },
    async updateOne(filter, update, options) {
      calls.push("touch");
      assert.deepEqual(Object.keys(filter).sort(), ["_id", "owner"]);
      checkSession(options.session);
      assert.deepEqual(update, { $inc: { taskLinkVersion: 1 } });
      assert.equal(options.timestamps, false);
      const row = projects.find(row => matches(row, filter));
      if (row) row.taskLinkVersion++;
      return { acknowledged: true, matchedCount: row ? 1 : 0 };
    },
  };
  const taskModel = {
    async create([fields], { session }) {
      calls.push("insert");
      checkSession(session);
      insertedIds.push(String(fields._id));
      const row = taskRow(String(fields._id), fields.project, { ...fields, _id: String(fields._id) });
      rows.push(row);
      if (insertErrors.length) throw insertErrors.shift();
      return [row];
    },
    find(filter) {
      assert.deepEqual(filter, { project });
      return { select: () => ({
        sort({ createdAt, _id }) {
          assert.equal(createdAt, _id);
          const ordered = rows.filter(row => matches(row, filter)).sort((a, b) =>
            (a.createdAt - b.createdAt) * createdAt || a._id.localeCompare(b._id) * _id);
          return { skip: offset => ({
            limit: limit => ({ lean: async () => ordered.slice(offset, offset + limit) }),
          }) };
        },
      }) };
    },
    async countDocuments(filter) {
      assert.deepEqual(filter, { project });
      return rows.filter(row => matches(row, filter)).length;
    },
    findById(id) {
      return { select: (projection) => {
        assert.equal(projection, "project");
        return { lean: async () => rows.find(row => row._id === id) ?? null };
      } };
    },
    findOne(filter) {
      scoped(filter);
      return query(rows.find(row => matches(row, filter)));
    },
    findOneAndUpdate(filter, update, options) {
      scoped(filter);
      assert.deepEqual(options, { runValidators: true, returnDocument: "after" });
      const row = rows.find(row => matches(row, filter));
      if (row) Object.assign(row, update.$set);
      return query(row);
    },
    async deleteOne(filter) {
      scoped(filter);
      const index = rows.findIndex(row => matches(row, filter));
      if (index >= 0) rows.splice(index, 1);
      return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
    },
  };
  const userModel = { exists: async ({ _id }) => _id === owner || _id === other };
  const server = createApp({ authConfig, userModel, projectModel, taskModel }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  const token = await signAccessToken(owner, authConfig);
  async function send(method, path, body, bearer = token) {
    const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : raw };
  }
  return { send, rows, projects, calls, transactionEvents, insertedIds };
}

function driverError(label, code) {
  const error = new mongoose.mongo.MongoServerError({ message: "Private driver detail", code });
  error.addErrorLabel(label);
  return error;
}

test("POST Task coordinates with Project, commits, and returns the public Task", async t => {
  const { send, rows, projects, calls, transactionEvents } = await setup(t);
  const response = await send("POST", nested, { title: "  Ship  ", dueDate: "2026-12-01T09:00:00+07:00" });
  assert.equal(response.status, 201);
  const { task } = response.body;
  assert.equal(response.headers.get("location"), "/api/tasks/" + task.id);
  assert.deepEqual(Object.keys(task).sort(), keys);
  assert.equal(task.projectId, project);
  assert.equal(task.title, "Ship");
  assert.equal(task.status, "todo");
  assert.equal(task.priority, "medium");
  assert.equal(task.dueDate, "2026-12-01T02:00:00.000Z");
  assert.ok(rows.at(-1).dueDate instanceof Date);
  assert.equal(projects[0].taskLinkVersion, 1);
  assert.deepEqual(calls, ["touch", "insert"]);
  assert.deepEqual(transactionEvents, ["start", "commit"]);
});

test("GET Tasks paginates within the owned Project with stable ordering", async t => {
  const { send } = await setup(t);
  const initial = await send("GET", nested);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.tasks.map(task => task.id), [secondTask, firstTask]);
  assert.deepEqual(initial.body.pagination, { page: 1, limit: 20, total: 2, totalPages: 1 });
  for (const [query, id] of [["page=2&limit=1", firstTask], ["sort=oldest&limit=1", firstTask]]) {
    const response = await send("GET", nested + "?" + query);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.tasks.map(task => task.id), [id]);
    assert.equal(response.body.pagination.totalPages, 2);
  }
});

test("GET, PATCH and DELETE Task are scoped to its authorized Project", async t => {
  const { send, rows } = await setup(t);
  const read = await send("GET", detail);
  assert.equal(read.status, 200);
  assert.deepEqual(Object.keys(read.body.task).sort(), keys);
  const patch = await send("PATCH", detail, { status: "done", description: "Completed", dueDate: null });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.task.status, "done");
  assert.equal(patch.body.task.title, "Task");
  assert.equal(rows[0].project, project);
  assert.equal(rows[0].description, "Completed");
  const removed = await send("DELETE", detail);
  assert.equal(removed.status, 204);
  assert.equal(removed.body, "");
  assert.equal((await send("GET", detail)).status, 404);
});

test("Foreign and nonexistent Projects and Tasks are hidden behind the same 404s", async t => {
  const { send, rows, calls } = await setup(t);
  for (const id of [foreignProject, missing]) {
    for (const method of ["GET", "POST"]) {
      const response = await send(method, "/projects/" + id + "/tasks", method === "POST" ? { title: "X" } : undefined);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "Project not found." });
    }
  }
  for (const id of [foreignTask, missing]) {
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await send(method, "/tasks/" + id, method === "PATCH" ? { title: "X" } : undefined);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "Task not found." });
    }
  }
  assert.deepEqual(calls, ["touch", "touch"]);
  assert.equal(rows.find(row => row._id === foreignTask).title, "Task");
});

test("All Task routes reject missing, invalid and deleted-user tokens", async t => {
  const { send, calls } = await setup(t);
  const invalid = await signAccessToken(owner, { ...authConfig, secret: randomBytes(32) });
  const deleted = await signAccessToken(missing, authConfig);
  for (const token of [null, invalid, deleted]) {
    for (const [method, path, body] of [
      ["POST", nested, { title: "X" }], ["GET", nested], ["GET", detail],
      ["PATCH", detail, { title: "X" }], ["DELETE", detail],
    ]) {
      const response = await send(method, path, body, token);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
  }
  assert.deepEqual(calls, []);
});

test("Task validation rejects malformed IDs, pagination and write attempts on protected fields", async t => {
  const { send, calls, rows } = await setup(t);
  for (const [method, path, body] of [
    ["GET", "/projects/bad/tasks"], ["GET", "/projects/%E0%A4%A/tasks"], ["GET", "/tasks/%E0%A4%A"],
    ["GET", nested + "?limit=101"], ["GET", nested + "?page=1&page=2"], ["GET", nested + "?sort=title"],
    ["GET", detail + "?owner=" + other], ["DELETE", detail + "?projectId=" + foreignProject],
    ["POST", nested, { title: " " }], ["POST", nested, { title: "X", status: "unknown" }],
    ["POST", nested, { title: "X", priority: "urgent" }], ["POST", nested, { title: "X", dueDate: "2026-12-01" }],
    ["POST", nested + "?owner=" + other, { title: "X" }], ["PATCH", detail, {}],
    ...["owner", "project", "projectId", "_id", "createdAt", "updatedAt"].map(field =>
      ["PATCH", detail, { title: "X", [field]: foreignProject }]),
  ]) {
    assert.equal((await send(method, path, body)).status, 400);
  }
  assert.deepEqual(calls, []);
  assert.equal(rows[0].title, "Task");
});

test("Failed Task insert aborts and rolls back both the Task and coordination write", async t => {
  const { send, rows, projects, transactionEvents } = await setup(t, { insertErrors: [new Error("Private")] });
  const response = await send("POST", nested, { title: "Fail" });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { message: "Internal server error." });
  assert.equal(rows.length, 3);
  assert.equal(projects[0].taskLinkVersion, 0);
  assert.deepEqual(transactionEvents, ["start", "abort"]);
});

test("Transient failure retries Task creation with the same ID", async t => {
  const { send, rows, projects, insertedIds, transactionEvents } = await setup(t, {
    insertErrors: [driverError("TransientTransactionError", 112)],
  });
  const response = await send("POST", nested, { title: "Retry" });
  assert.equal(response.status, 201);
  assert.deepEqual(insertedIds, [response.body.task.id, response.body.task.id]);
  assert.equal(rows.length, 4);
  assert.equal(projects[0].taskLinkVersion, 1);
  assert.deepEqual(transactionEvents, ["start", "abort", "start", "commit"]);
});

test("Create Task returns 503 after the shared transaction retry limit", async t => {
  const { send, rows, projects, insertedIds, transactionEvents } = await setup(t, {
    insertErrors: Array.from({ length: 4 }, () => driverError("TransientTransactionError", 112)),
  });
  const response = await send("POST", nested, { title: "Exhaust retries" });
  assert.equal(response.status, 503);
  assert.equal(insertedIds.length, 3);
  assert.equal(rows.length, 3);
  assert.equal(projects[0].taskLinkVersion, 0);
  assert.equal(transactionEvents.includes("commit"), false);
});

test("Unknown commit is retried without re-inserting; an unconfirmed commit returns 503", async t => {
  const recovered = await setup(t, { commitErrors: [driverError("UnknownTransactionCommitResult", 91)] });
  assert.equal((await recovered.send("POST", nested, { title: "Retry commit" })).status, 201);
  assert.deepEqual(recovered.transactionEvents, ["start", "commit", "commit"]);
  assert.equal(recovered.insertedIds.length, 1);
  const unconfirmed = await setup(t, { commitErrors: [driverError("UnknownTransactionCommitResult", 50)] });
  const response = await unconfirmed.send("POST", nested, { title: "Unconfirmed" });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { message: "Task creation could not be confirmed." });
  assert.equal(response.headers.get("location"), null);
  assert.equal(unconfirmed.insertedIds.length, 1);
});
