import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";
import User from "../src/models/User.js";
import Project from "../src/models/Project.js";
import Task from "../src/models/Task.js";

const id = new Types.ObjectId();

test("all models reject missing required fields", async () => {
  for (const [Model, fields] of [
    [User, ["name", "email", "passwordHash"]],
    [Project, ["name", "owner"]],
    [Task, ["project", "title"]],
  ]) {
    await assert.rejects(new Model().validate(), (error) => {
      assert.deepEqual(Object.keys(error.errors).sort(), fields.sort());
      assert.ok(Object.values(error.errors).every(({ kind }) => kind === "required"));
      return true;
    });
  }
});

test("User normalizes email, rejects invalid addresses and declares one unique index", async () => {
  const user = new User({
    name: "Minh",
    email: "  Minh.Example+Alias@Example.COM  ",
    passwordHash: "test-hash",
  });

  await user.validate();
  assert.equal(user.email, "minh.example+alias@example.com");
  assert.equal(User.schema.path("passwordHash").options.select, false);
  assert.deepEqual(User.schema.indexes(), [[{ email: 1 }, { unique: true }]]);

  user.email = "invalid-email";
  await assert.rejects(user.validate(), /Invalid email address/);
});

test("Task accepts only the supported status values", async () => {
  for (const status of ["todo", "in_progress", "done"]) {
    await new Task({ project: id, title: "Test", status }).validate();
  }
  await assert.rejects(
    new Task({ project: id, title: "Test", status: "archived" }).validate(),
    (error) => error.errors?.status?.kind === "enum",
  );
});

test("Task accepts only the supported priority values", async () => {
  for (const priority of ["low", "medium", "high"]) {
    await new Task({ project: id, title: "Test", priority }).validate();
  }
  await assert.rejects(
    new Task({ project: id, title: "Test", priority: "urgent" }).validate(),
    (error) => error.errors?.priority?.kind === "enum",
  );
});

test("Project and Task apply the expected defaults", () => {
  assert.equal(new Project().description, "");
  const task = new Task();
  assert.equal(task.description, "");
  assert.equal(task.status, "todo");
  assert.equal(task.priority, "medium");
  assert.equal(task.dueDate, null);
});

test("Project.owner and Task.project accept ObjectIds and reject invalid IDs", async () => {
  for (const [Model, field, ref, fields] of [
    [Project, "owner", "User", { name: "MERN" }],
    [Task, "project", "Project", { title: "Test" }],
  ]) {
    const document = new Model({ ...fields, [field]: id.toHexString() });
    await document.validate();
    assert.ok(document[field] instanceof Types.ObjectId);
    assert.ok(document[field].equals(id));
    assert.equal(Model.schema.path(field).options.ref, ref);

    await assert.rejects(
      new Model({ ...fields, [field]: "invalid-id" }).validate(),
      (error) => error.errors?.[field]?.name === "CastError",
    );
  }
});

test("all models configure timestamps as dates", () => {
  for (const Model of [User, Project, Task]) {
    assert.equal(Model.schema.options.timestamps, true);
    assert.equal(Model.schema.path("createdAt").instance, "Date");
    assert.equal(Model.schema.path("updatedAt").instance, "Date");
  }
});

test("Project and Task declare only their compound indexes", () => {
  assert.deepEqual(Project.schema.indexes(), [[{ owner: 1, createdAt: -1, _id: -1 }, {}]]);
  assert.deepEqual(Task.schema.indexes(), [[{ project: 1, createdAt: -1, _id: -1 }, {}]]);
});
