import { Router } from "express";
import { createTaskController } from "../controllers/task.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { createTaskService } from "../services/task.service.js";
import {
  createTaskBody, emptyTaskBody, emptyTaskQuery, listTaskQuery,
  projectTaskParams, taskParams, updateTaskBody,
} from "../validators/task.schema.js";

function invalidTaskRequest(res) {
  return res.status(400).json({ message: "Invalid task request." });
}

function validate(params, query = emptyTaskQuery, body = emptyTaskBody) {
  return (req, res, next) => {
    for (const [source, schema] of Object.entries({ params, query, body })) {
      const result = schema.safeParse(req[source]);
      if (!result.success) return invalidTaskRequest(res);
      res.locals[source] = result.data;
    }
    return next();
  };
}

function handleTaskUrlError(error, req, res, next) {
  if (error instanceof URIError && error.status === 400) return invalidTaskRequest(res);
  return next(error);
}

export function createTaskRouters({ authConfig, userModel, projectModel, taskModel }) {
  const projectTasks = Router();
  const tasks = Router();
  const controller = createTaskController(createTaskService(projectModel, taskModel));
  const auth = [authenticate(authConfig), async (req, res, next) => {
    if (!(await userModel.exists({ _id: req.user.id }))) {
      return res.set("WWW-Authenticate", "Bearer").status(401).json({ message: "Unauthorized." });
    }
    return next();
  }];

  projectTasks.post("/:projectId/tasks", auth, validate(projectTaskParams, emptyTaskQuery, createTaskBody), controller.create);
  projectTasks.get("/:projectId/tasks", auth, validate(projectTaskParams, listTaskQuery), controller.list);
  tasks.get("/:taskId", auth, validate(taskParams), controller.get);
  tasks.patch("/:taskId", auth, validate(taskParams, emptyTaskQuery, updateTaskBody), controller.update);
  tasks.delete("/:taskId", auth, validate(taskParams), controller.remove);
  projectTasks.use(handleTaskUrlError);
  tasks.use(handleTaskUrlError);
  return { projectTasks, tasks };
}
