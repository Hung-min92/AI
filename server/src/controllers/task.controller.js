import { ProjectTransactionUnavailableError } from "../services/project-transaction.js";

function notFound(res, resource) {
  return res.status(404).json({ message: resource + " not found." });
}

export function createTaskController(service) {
  return {
    async create(req, res) {
      let task;
      try {
        task = await service.create(req.user.id, res.locals.params.projectId, res.locals.body);
      } catch (error) {
        if (!(error instanceof ProjectTransactionUnavailableError)) throw error;
        return res.status(503).json({ message: "Task creation could not be confirmed." });
      }
      if (!task) return notFound(res, "Project");
      return res.location(`/api/tasks/${task.id}`).status(201).json({ task });
    },

    async list(req, res) {
      const list = await service.list(req.user.id, res.locals.params.projectId, res.locals.query);
      return list ? res.json(list) : notFound(res, "Project");
    },

    async get(req, res) {
      const task = await service.get(req.user.id, res.locals.params.taskId);
      return task ? res.json({ task }) : notFound(res, "Task");
    },

    async update(req, res) {
      const task = await service.update(req.user.id, res.locals.params.taskId, res.locals.body);
      return task ? res.json({ task }) : notFound(res, "Task");
    },

    async remove(req, res) {
      const deleted = await service.remove(req.user.id, res.locals.params.taskId);
      return deleted ? res.status(204).end() : notFound(res, "Task");
    },
  };
}
