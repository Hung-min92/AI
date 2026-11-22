import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import mongoose from "mongoose";
import { configureDnsServers } from "../../src/config/db.js";
import User from "../../src/models/User.js";
import Project from "../../src/models/Project.js";
import Task from "../../src/models/Task.js";

const databaseName = "ai_task_manager_test";
const runId = randomUUID();
const testEmail = `integration-${runId}@example.com`;
const models = [User, Project, Task];
const fixtures = [];
const connection = mongoose.createConnection();
let testModels;

const safeCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ENODATA", "EAI_AGAIN",
  "ESERVFAIL", "ETIMEOUT", "ETIMEDOUT", 13, 18, 26, 11000,
]);

function safeCode(error) {
  const candidates = [error, error?.cause];
  for (const reason of [error?.reason, error?.cause?.reason]) {
    for (const server of reason?.servers?.values?.() ?? []) {
      candidates.push(server.error, server.error?.cause);
    }
  }
  return candidates.find((candidate) => safeCodes.has(candidate?.code))?.code ?? "N/A";
}

async function runDatabaseOperation(operation, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${operation} failed (code: ${safeCode(error)}).`);
  }
}

function readTestUri() {
  const uri = process.env.MONGODB_TEST_URI?.trim();
  if (!uri) throw new Error("MONGODB_TEST_URI is required.");

  let client;
  try {
    // The constructor parses options without opening a connection.
    client = new mongoose.mongo.MongoClient(uri);
  } catch {
    throw new Error("MONGODB_TEST_URI is not a valid MongoDB connection string.");
  }
  const uriPath = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^?#]*)(?:[?#]|$)/)?.[1];
  if (uriPath !== databaseName || client.options.dbName !== databaseName) {
    throw new Error(`MONGODB_TEST_URI must explicitly target ${databaseName}.`);
  }
  return uri;
}

function verifyDatabase() {
  assert.ok(connection.db?.databaseName === databaseName, "Unexpected test database.");
}

async function verifyIndexes(model) {
  const actual = await runDatabaseOperation(
    `Read indexes for ${model.modelName}`,
    async () => {
      try {
        return await model.listIndexes();
      } catch (error) {
        // A missing collection has none of the required indexes.
        if (error.code === 26) return [];
        throw error;
      }
    },
  );

  for (const [key, options] of model.schema.indexes()) {
    const found = actual.some((index) =>
      isDeepStrictEqual(Object.entries(index.key), Object.entries(key)) &&
      Boolean(index.unique) === Boolean(options.unique) &&
      !index.sparse && !index.partialFilterExpression,
    );
    assert.ok(found, `Missing required index for ${model.modelName}: ${JSON.stringify(key)}${options.unique ? " (unique)" : ""}.`);
  }
}

before(async () => {
  const uri = readTestUri();
  const resolvers = process.env.MONGODB_TEST_DNS_SERVERS?.trim();
  if (resolvers && uri.startsWith("mongodb+srv://")) {
    try {
      configureDnsServers(resolvers.split(",").map((value) => value.trim()));
    } catch {
      throw new Error("MONGODB_TEST_DNS_SERVERS must contain comma-separated DNS server IPs.");
    }
  }

  await runDatabaseOperation("MongoDB test connection", () => connection.openUri(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoCreate: false,
    autoIndex: false,
  }));
  verifyDatabase();
  testModels = Object.fromEntries(models.map((model) => [
    model.modelName,
    connection.model(model.modelName, model.schema, model.collection.name),
  ]));
  for (const model of Object.values(testModels)) {
    await verifyIndexes(model);
  }
});

async function createFixture(model, fields, marker, expectedDuplicate = false) {
  verifyDatabase();
  const _id = new mongoose.Types.ObjectId();
  fixtures.push({ model, filter: { _id, ...marker } });

  try {
    return await model.create({ _id, ...fields });
  } catch (error) {
    if (expectedDuplicate && error.code === 11000 &&
        isDeepStrictEqual(error.keyPattern, { email: 1 })) {
      throw Object.assign(new Error("Duplicate email."), { code: 11000 });
    }
    throw new Error(`Create ${model.modelName} fixture failed (code: ${safeCode(error)}).`);
  }
}

after(async (t) => {
  const failures = [];
  const deleted = {};
  let verifiedAbsent = 0;
  try {
    if (fixtures.length) {
      verifyDatabase();
      for (const { model, filter } of fixtures.reverse()) {
        try {
          const result = await runDatabaseOperation(
            `Clean up ${model.modelName}`, () => model.deleteOne(filter),
          );
          assert.ok(result.acknowledged, `Cleanup was not acknowledged for ${model.modelName}.`);
          deleted[model.modelName] = (deleted[model.modelName] ?? 0) + result.deletedCount;
        } catch (error) {
          failures.push(error);
        }
      }
      for (const { model, filter } of fixtures) {
        try {
          const remaining = await runDatabaseOperation(
            `Verify cleanup for ${model.modelName}`, () => model.exists(filter),
          );
          assert.ok(!remaining, `A ${model.modelName} fixture remains after cleanup.`);
          verifiedAbsent++;
        } catch (error) {
          failures.push(error);
        }
      }
      t.diagnostic(`Run ${runId}: deleted ${JSON.stringify(deleted)}; verified absent ${verifiedAbsent}/${fixtures.length} fixture IDs.`);
    }
  } finally {
    await runDatabaseOperation("Close MongoDB test connection", () => connection.close());
  }
  if (failures.length) {
    throw new AggregateError(failures, `Fixture cleanup failed for run ${runId}.`);
  }
});

test("User, Project and Task persist fields, references and timestamps", async (t) => {
  const { User, Project, Task } = testModels;
  const name = `Integration ${runId}`;
  const user = await createFixture(User, {
    name,
    email: `  ${testEmail.toUpperCase()}  `,
    passwordHash: "integration-placeholder",
  }, { email: testEmail });
  const project = await createFixture(Project, { name, owner: user._id }, { name, owner: user._id });
  const task = await createFixture(Task, { title: name, project: project._id }, {
    title: name,
    project: project._id,
  });

  const savedUser = await runDatabaseOperation("Read User", () => User.findById(user._id));
  const savedProject = await runDatabaseOperation("Read Project", () => Project.findOne({
    _id: project._id,
    owner: user._id,
  }));
  const savedTask = await runDatabaseOperation("Read Task", () => Task.findOne({
    _id: task._id,
    project: project._id,
  }));

  await t.test("creates and reads User", () => {
    assert.equal(savedUser?.email, testEmail);
    assert.equal(savedUser.name, name);
    assert.ok(savedUser.passwordHash === undefined, "Default query exposed passwordHash.");
  });
  await t.test("creates and reads Project", () => {
    assert.equal(savedProject?.name, name);
    assert.ok(savedProject.owner instanceof mongoose.Types.ObjectId);
    assert.ok(savedProject.owner.equals(user._id));
  });
  await t.test("creates and reads Task", () => {
    assert.equal(savedTask?.title, name);
    assert.ok(savedTask.project instanceof mongoose.Types.ObjectId);
    assert.ok(savedTask.project.equals(project._id));
    assert.equal(savedTask.status, "todo");
    assert.equal(savedTask.priority, "medium");
    assert.equal(savedTask.dueDate, null);
  });
  await t.test("persists timestamps for all three models", () => {
    for (const doc of [savedUser, savedProject, savedTask]) {
      assert.ok(doc?.createdAt instanceof Date && Number.isFinite(doc.createdAt.getTime()));
      assert.ok(doc.updatedAt instanceof Date && Number.isFinite(doc.updatedAt.getTime()));
      assert.ok(doc.updatedAt >= doc.createdAt);
    }
  });
});

test("MongoDB rejects duplicate normalized email with E11000", async () => {
  const { User } = testModels;
  const email = `duplicate-${runId}@example.com`;
  const fields = { name: "Integration duplicate", passwordHash: "integration-placeholder" };
  await createFixture(User, { ...fields, email }, { email });
  await assert.rejects(
    createFixture(User, { ...fields, email: `  ${email.toUpperCase()}  ` }, { email }, true),
    { code: 11000 },
  );
  const count = await runDatabaseOperation("Count fixture users", () => User.countDocuments({ email }));
  assert.equal(count, 1);
});
