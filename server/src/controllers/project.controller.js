function projectNotFound(res) {
  return res.status(404).json({ message: "Project not found." });
}

function sendProject(res, project) {
  if (!project) return projectNotFound(res);
  return res.json({ project });
}

export function createProjectController(service) {
  return {
    async create(req, res) {
      const project = await service.create(req.user.id, res.locals.body);
      return res.location(`/api/projects/${project.id}`).status(201).json({ project });
    },

    async list(req, res) {
      return res.json(await service.list(req.user.id, res.locals.query));
    },

    async get(req, res) {
      return sendProject(res, await service.get(req.user.id, res.locals.params.id));
    },

    async update(req, res) {
      return sendProject(res, await service.update(req.user.id, res.locals.params.id, res.locals.body));
    },

    async remove(req, res) {
      const result = await service.remove(req.user.id, res.locals.params.id);
      if (result === "notFound") return projectNotFound(res);
      if (result === "hasTasks") {
        return res.status(409).json({ message: "Project still has tasks." });
      }
      if (result === "unavailable") {
        return res.status(503).json({ message: "Project deletion could not be confirmed." });
      }
      return res.status(204).end();
    },
  };
}
