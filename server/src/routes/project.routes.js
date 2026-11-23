import { Router } from "express";
import { createProjectController } from "../controllers/project.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { createProjectService } from "../services/project.service.js";
import {
  createProjectSchema,
  listProjectsSchema,
  projectParamsSchema,
  updateProjectSchema,
} from "../validators/project.schema.js";

function validate(schema, source) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) return res.status(400).json({ message: "Invalid project request." });
    res.locals[source] = parsed.data;
    return next();
  };
}

export function createProjectRouter({ authConfig, userModel, projectModel, taskModel }) {
  const router = Router();
  const controller = createProjectController(createProjectService(projectModel, taskModel));
  const validateId = validate(projectParamsSchema, "params");

  router.use(authenticate(authConfig), async (req, res, next) => {
    if (!(await userModel.exists({ _id: req.user.id }))) {
      return res.set("WWW-Authenticate", "Bearer").status(401).json({ message: "Unauthorized." });
    }
    return next();
  });
  router.post("/", validate(createProjectSchema, "body"), controller.create);
  router.get("/", validate(listProjectsSchema, "query"), controller.list);
  router.get("/:id", validateId, controller.get);
  router.patch("/:id", validateId, validate(updateProjectSchema, "body"), controller.update);
  router.delete("/:id", validateId, controller.remove);

  router.use((error, req, res, next) => {
    if (error instanceof URIError && error.status === 400) {
      return res.status(400).json({ message: "Invalid project request." });
    }
    return next(error);
  });
  return router;
}
