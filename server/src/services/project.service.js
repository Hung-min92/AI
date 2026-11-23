import {
  ProjectTransactionUnavailableError,
  runProjectTransaction,
  touchOwnedProject,
} from "./project-transaction.js";

const publicFields = "name description createdAt updatedAt";
const projectMissing = new Error("Project not found.");
const projectHasTasks = new Error("Project still has tasks.");

function publicProject(project) {
  return {
    id: String(project._id),
    name: project.name,
    description: project.description ?? "",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function createProjectService(projectModel, taskModel) {
  return {
    async create(owner, fields) {
      return publicProject(await projectModel.create({ ...fields, owner }));
    },

    async list(owner, { page, limit, sort }) {
      const filter = { owner };
      const direction = sort === "oldest" ? 1 : -1;
      const [rows, total] = await Promise.all([
        projectModel.find(filter).select(publicFields)
          .sort({ createdAt: direction, _id: direction })
          .skip((page - 1) * limit).limit(limit).lean(),
        projectModel.countDocuments(filter),
      ]);
      return {
        projects: rows.map(publicProject),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async get(owner, id) {
      const project = await projectModel.findOne({ _id: id, owner }).select(publicFields).lean();
      return project ? publicProject(project) : null;
    },

    async update(owner, id, fields) {
      const project = await projectModel.findOneAndUpdate(
        { _id: id, owner },
        { $set: fields },
        { runValidators: true, returnDocument: "after" },
      ).select(publicFields).lean();
      return project ? publicProject(project) : null;
    },

    async remove(owner, id) {
      const filter = { _id: id, owner };
      try {
        return await runProjectTransaction(projectModel, async (session) => {
          if (!(await touchOwnedProject(projectModel, filter, session))) throw projectMissing;
          if (await taskModel.exists({ project: id }).session(session)) throw projectHasTasks;

          const result = await projectModel.deleteOne(filter, { session });
          if (!result.acknowledged) throw new Error("Project deletion was not acknowledged.");
          if (result.deletedCount !== 1) throw projectMissing;
          return "deleted";
        });
      } catch (error) {
        if (error === projectMissing) return "notFound";
        if (error === projectHasTasks) return "hasTasks";
        if (error instanceof ProjectTransactionUnavailableError) return "unavailable";
        throw error;
      }
    },
  };
}
