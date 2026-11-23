import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { SignJWT } from "jose";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/config/auth.js";
import { signAccessToken } from "../src/services/token.service.js";

const authConfig = loadAuthConfig({ JWT_SECRET: randomBytes(32).toString("base64") });
const owner = "507f1f77bcf86cd799439011";
const otherOwner = "507f1f77bcf86cd799439012";
const removedUser = "507f1f77bcf86cd799439013";
const firstId = "507f1f77bcf86cd799439021";
const secondId = "507f1f77bcf86cd799439022";
const foreignId = "507f1f77bcf86cd799439023";
const missingId = "507f1f77bcf86cd799439024";
const createdId = "507f1f77bcf86cd799439025";
const thirdId = "507f1f77bcf86cd799439026";
const createdAt = new Date("2026-01-01T00:00:00Z");
const newerDate = new Date("2026-01-02T00:00:00Z");
const newerId = "507f1f77bcf86cd799439020";
const publicKeys = ["createdAt", "description", "id", "name", "updatedAt"];

function row(_id, owner, date = createdAt) {
  return { _id, owner, name: "Project", description: "Original", createdAt: date, updatedAt: date };
}

function fakeProjectModel({ disappearOnDelete = false, acknowledgeDelete = true } = {}) {
  const rows = [
    row(firstId, owner),
    row(secondId, owner),
    row(foreignId, otherOwner),
    row(thirdId, owner, newerDate),
    row(newerId, owner, newerDate),
  ];
  const calls = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const fieldQuery = (value) => ({ select: () => ({ lean: async () => value }) });

  return {
    rows,
    calls,
    async create(fields) {
      calls.push("create");
      const project = { ...row(createdId, fields.owner), description: "", ...fields };
      rows.push(project);
      return project;
    },
    find(filter) {
      calls.push("find");
      assert.deepEqual(filter, { owner });
      return {
        select: () => ({
          sort(sort) {
            assert.deepEqual(Object.keys(sort), ["createdAt", "_id"]);
            assert.equal(sort.createdAt, sort._id);
            const sorted = rows.filter((row) => matches(row, filter)).sort((a, b) =>
              (a.createdAt - b.createdAt) * sort.createdAt || a._id.localeCompare(b._id) * sort._id);
            return {
              skip: (offset) => ({
                limit: (limit) => ({ lean: async () => sorted.slice(offset, offset + limit) }),
              }),
            };
          },
        }),
      };
    },
    async countDocuments(filter) {
      calls.push("countDocuments");
      assert.deepEqual(filter, { owner });
      return rows.filter((row) => matches(row, filter)).length;
    },
    findOne(filter) {
      calls.push("findOne");
      assert.equal(filter.owner, owner);
      return fieldQuery(rows.find((row) => matches(row, filter)) ?? null);
    },
    findOneAndUpdate(filter, update, options) {
      calls.push("findOneAndUpdate");
      assert.equal(filter.owner, owner);
      assert.deepEqual(options, { runValidators: true, returnDocument: "after" });
      const project = rows.find((row) => matches(row, filter));
      if (!project) return fieldQuery(null);
      Object.assign(project, update.$set, { updatedAt: newerDate });
      return fieldQuery(project);
    },
    async exists(filter) {
      calls.push("exists");
      assert.equal(filter.owner, owner);
      assert.deepEqual(Object.keys(filter).sort(), ["_id", "owner"]);
      const project = rows.find((row) => matches(row, filter));
      return project ? { _id: project._id } : null;
    },
    async deleteOne(filter) {
      calls.push("deleteOne");
      assert.equal(filter.owner, owner);
      assert.deepEqual(Object.keys(filter).sort(), ["_id", "owner"]);
      if (!acknowledgeDelete) return { acknowledged: false };
      const index = rows.findIndex((row) => matches(row, filter));
      if (index !== -1) rows.splice(index, 1);
      return { acknowledged: true, deletedCount: index === -1 || disappearOnDelete ? 0 : 1 };
    },
  };
}

async function setup(t, { tasks = [], ...projectOptions } = {}) {
  const projectModel = fakeProjectModel(projectOptions);
  const taskLookups = [];
  const taskModel = {
    async exists(filter) {
      assert.deepEqual(Object.keys(filter), ["project"]);
      taskLookups.push(filter.project);
      const task = tasks.find(({ project }) => project === filter.project);
      return task ? { _id: task._id } : null;
    },
  };
  const userLookups = [];
  const userModel = {
    async exists({ _id }) {
      userLookups.push(_id);
      return _id === owner || _id === otherOwner ? { _id } : null;
    },
  };
  const server = createApp({ authConfig, userModel, projectModel, taskModel }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
  const ownerToken = await signAccessToken(owner, authConfig);
  const send = async ({ method = "GET", path = "", body, token = ownerToken } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.text();
    return { status: response.status, headers: response.headers, body: data ? JSON.parse(data) : data };
  };
  return { send, projectModel, userLookups, taskLookups };
}

test("POST creates a project for the JWT user and returns its public representation and Location", async (t) => {
  const { send, projectModel } = await setup(t);
  const response = await send({ method: "POST", body: { name: "  Roadmap  " } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("location"), `/api/projects/${createdId}`);
  assert.deepEqual(Object.keys(response.body.project).sort(), publicKeys);
  assert.deepEqual(response.body.project, {
    id: createdId,
    name: "Roadmap",
    description: "",
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  });
  assert.equal(projectModel.rows.at(-1).owner, owner);
});

test("POST rejects unknown fields and invalid names or descriptions before creating a project", async (t) => {
  const { send, projectModel } = await setup(t);
  for (const body of [
    { name: "Roadmap", owner: otherOwner },
    { name: "Roadmap", userId: otherOwner },
    {},
    { name: "   " },
    { name: "x".repeat(121) },
    { name: "Roadmap", description: "x".repeat(2001) },
  ]) {
    assert.equal((await send({ method: "POST", body })).status, 400);
  }
  assert.deepEqual(projectModel.calls, []);
});

test("GET list scopes results and total to the JWT user with default pagination", async (t) => {
  const { send } = await setup(t);
  const { status, body } = await send();
  assert.equal(status, 200);
  assert.deepEqual(body.pagination, { page: 1, limit: 20, total: 4, totalPages: 1 });
  assert.deepEqual(body.projects.map((project) => project.id), [thirdId, newerId, secondId, firstId]);
  assert.deepEqual(Object.keys(body.projects[0]).sort(), publicKeys);
});

test("GET list paginates newest and oldest using timestamps and stable ID tie-breaking", async (t) => {
  const { send } = await setup(t);
  for (const [sort, expected] of [["newest", [secondId, firstId]], ["oldest", [newerId, thirdId]]]) {
    const { status, body } = await send({ path: `?page=2&limit=2&sort=${sort}` });
    assert.equal(status, 200);
    assert.deepEqual(body.projects.map((project) => project.id), expected);
    assert.deepEqual(body.pagination, { page: 2, limit: 2, total: 4, totalPages: 2 });
  }
  const last = await send({ path: "?page=1000&limit=100" });
  assert.equal(last.status, 200);
  assert.deepEqual(last.body.projects, []);
  assert.deepEqual(last.body.pagination, { page: 1000, limit: 100, total: 4, totalPages: 1 });
});

test("GET list rejects out-of-bounds, duplicate or unsupported query parameters", async (t) => {
  const { send, projectModel } = await setup(t);
  for (const query of [
    "page=1001", "page=0", "page=1.5", "page=1&page=2",
    "limit=101", "limit=0", "sort=name", `owner=${otherOwner}`,
  ]) {
    assert.equal((await send({ path: `?${query}` })).status, 400);
  }
  assert.deepEqual(projectModel.calls, []);
});

test("GET detail returns the owned project and treats missing and foreign projects identically", async (t) => {
  const { send } = await setup(t);
  const owned = await send({ path: `/${firstId}` });
  assert.equal(owned.status, 200);
  assert.equal(owned.body.project.id, firstId);
  assert.deepEqual(Object.keys(owned.body.project).sort(), publicKeys);
  for (const id of [foreignId, missingId]) {
    const result = await send({ path: `/${id}` });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { message: "Project not found." });
  }
  assert.equal((await send({ path: "/bad-id" })).status, 400);
});

test("PATCH updates allowed fields, preserves ownership, and hides missing or foreign records", async (t) => {
  const { send, projectModel } = await setup(t);
  const update = (id, body) => send({ method: "PATCH", path: `/${id}`, body });
  const response = await update(firstId, { name: " Renamed ", description: "" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.project, {
    id: firstId,
    name: "Renamed",
    description: "",
    createdAt: createdAt.toISOString(),
    updatedAt: newerDate.toISOString(),
  });
  for (const id of [foreignId, missingId]) {
    const result = await update(id, { name: "Wrong project" });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { message: "Project not found." });
  }
  for (const invalid of [{}, { owner: otherOwner }, { createdAt }, { updatedAt: newerDate }]) {
    assert.equal((await update(firstId, invalid)).status, 400);
  }
  assert.equal((await update("bad-id", { name: "Bad ID" })).status, 400);
  assert.equal(projectModel.rows.find((row) => row._id === firstId).owner, owner);
  assert.equal(projectModel.rows.find((row) => row._id === foreignId).name, "Project");
  assert.equal(projectModel.calls.length, 3);
});

test("all Project endpoints reject missing, wrong, expired or deleted-user tokens before querying Projects", async (t) => {
  const { send, projectModel, userLookups } = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setSubject(owner).setIssuer(authConfig.issuer).setAudience(authConfig.audience)
    .setIssuedAt(now - 901).setExpirationTime(now - 1).sign(authConfig.secret);
  const wrong = await signAccessToken(owner, { ...authConfig, secret: randomBytes(32) });
  const removed = await signAccessToken(removedUser, authConfig);
  for (const token of [null, wrong, expired, removed]) {
    for (const route of [
      { method: "POST", body: { name: "Roadmap" } },
      { method: "GET" },
      { method: "GET", path: `/${firstId}` },
      { method: "PATCH", path: `/${firstId}`, body: { name: "New name" } },
    ]) {
      const response = await send({ ...route, token });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
  }
  assert.deepEqual(userLookups, [removedUser, removedUser, removedUser, removedUser]);
  assert.deepEqual(projectModel.calls, []);
});

test("DELETE removes an owned empty Project and returns 204 without a body", async (t) => {
  const { send, projectModel, taskLookups } = await setup(t);
  const response = await send({ method: "DELETE", path: `/${firstId}` });
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
  assert.equal(projectModel.rows.some(({ _id }) => _id === firstId), false);
  assert.deepEqual(projectModel.calls, ["exists", "deleteOne"]);
  assert.deepEqual(taskLookups, [firstId]);
});

test("DELETE returns 409 and preserves the Project and Tasks when a linked Task exists", async (t) => {
  const fixture = { _id: "507f1f77bcf86cd799439031", project: firstId };
  const tasks = [{ ...fixture }];
  const { send, projectModel, taskLookups } = await setup(t, { tasks });
  const project = { ...projectModel.rows.find(({ _id }) => _id === firstId) };
  const response = await send({ method: "DELETE", path: `/${firstId}` });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { message: "Project still has tasks." });
  assert.deepEqual(projectModel.rows.find(({ _id }) => _id === firstId), project);
  assert.deepEqual(tasks, [fixture]);
  assert.deepEqual(projectModel.calls, ["exists"]);
  assert.deepEqual(taskLookups, [firstId]);
});

test("DELETE treats missing and foreign Projects identically without looking up Tasks", async (t) => {
  const tasks = [{ _id: "507f1f77bcf86cd799439032", project: foreignId }];
  const { send, projectModel, taskLookups } = await setup(t, { tasks });
  for (const id of [foreignId, missingId]) {
    const response = await send({
      method: "DELETE", path: `/${id}?owner=${otherOwner}`, body: { userId: otherOwner },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { message: "Project not found." });
  }
  assert.equal(projectModel.rows.some(({ _id }) => _id === foreignId), true);
  assert.deepEqual(projectModel.calls, ["exists", "exists"]);
  assert.deepEqual(taskLookups, []);
});

test("DELETE rejects invalid Project IDs before checking either model", async (t) => {
  const { send, projectModel, taskLookups } = await setup(t);
  assert.equal((await send({ method: "DELETE", path: "/bad-id" })).status, 400);
  assert.deepEqual(projectModel.calls, []);
  assert.deepEqual(taskLookups, []);
});

test("DELETE rejects missing or wrong JWTs and tokens of deleted Users before Project or Task lookups", async (t) => {
  const { send, projectModel, userLookups, taskLookups } = await setup(t);
  const wrong = await signAccessToken(owner, { ...authConfig, secret: randomBytes(32) });
  const removed = await signAccessToken(removedUser, authConfig);
  for (const token of [null, wrong, removed]) {
    const response = await send({ method: "DELETE", path: `/${firstId}`, token });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
  assert.deepEqual(userLookups, [removedUser]);
  assert.deepEqual(projectModel.calls, []);
  assert.deepEqual(taskLookups, []);
});

test("DELETE returns 404 when the Project disappears before the delete operation", async (t) => {
  const { send, projectModel, taskLookups } = await setup(t, { disappearOnDelete: true });
  const response = await send({ method: "DELETE", path: `/${firstId}` });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { message: "Project not found." });
  assert.deepEqual(projectModel.calls, ["exists", "deleteOne"]);
  assert.deepEqual(taskLookups, [firstId]);
});

test("DELETE returns a generic 500 for an unacknowledged delete", async (t) => {
  const { send } = await setup(t, { acknowledgeDelete: false });
  const response = await send({ method: "DELETE", path: `/${firstId}` });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { message: "Internal server error." });
});

test("malformed URL encoding in a Project ID returns 400 before querying Projects", async (t) => {
  const { send, projectModel, taskLookups } = await setup(t);
  for (const method of ["GET", "PATCH", "DELETE"]) {
    const response = await send({ method, path: "/%E0%A4%A" });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "Invalid project request." });
  }
  assert.deepEqual(projectModel.calls, []);
  assert.deepEqual(taskLookups, []);
});
