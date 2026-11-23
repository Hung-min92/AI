import { Types } from "mongoose";
import { runProjectTransaction, touchOwnedProject } from "./project-transaction.js";

const publicFields = "project title description status priority dueDate createdAt updatedAt";
const projectMissing = new Error("Project not found.");

function publicTask(task) {
  return {
    id: String(task._id),
    projectId: String(task.project),
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function createTaskService(projectModel, taskModel) {
  const ownsProject = (owner, project) => projectModel.exists({ _id: project, owner });

  async function authorizedTask(owner, id) {
    const task = await taskModel.findById(id).select("project").lean();
    if (!task || !(await ownsProject(owner, task.project))) return null;
    return { _id: id, project: task.project };
  }

  return {
    async create(owner, projectId, fields) {
      const _id = new Types.ObjectId();
      try {
        const task = await runProjectTransaction(projectModel, async (session) => {
          if (!(await touchOwnedProject(projectModel, { _id: projectId, owner }, session))) {
            throw projectMissing;
          }
          const [created] = await taskModel.create([{ ...fields, _id, project: projectId }], { session });
          return created;
        });
        return publicTask(task);
      } catch (error) {
        if (error === projectMissing) return null;
        throw error;
      }
    },

    async list(owner, projectId, { page, limit, sort }) {
      if (!(await ownsProject(owner, projectId))) return null;
      const filter = { project: projectId };
      const direction = sort === "oldest" ? 1 : -1;
      const [rows, total] = await Promise.all([
        taskModel.find(filter).select(publicFields)
          .sort({ createdAt: direction, _id: direction })
          .skip((page - 1) * limit).limit(limit).lean(),
        taskModel.countDocuments(filter),
      ]);
      return {
        tasks: rows.map(publicTask),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async get(owner, id) {
      const filter = await authorizedTask(owner, id);
      if (!filter) return null;
      const task = await taskModel.findOne(filter).select(publicFields).lean();
      return task ? publicTask(task) : null;
    },

    async update(owner, id, fields) {
      const filter = await authorizedTask(owner, id);
      if (!filter) return null;
      const task = await taskModel.findOneAndUpdate(filter, { $set: fields }, {
        runValidators: true, returnDocument: "after",
      }).select(publicFields).lean();
      return task ? publicTask(task) : null;
    },

    async remove(owner, id) {
      const filter = await authorizedTask(owner, id);
      if (!filter) return false;
      const result = await taskModel.deleteOne(filter);
      if (!result.acknowledged) throw new Error("Task deletion was not acknowledged.");
      return result.deletedCount === 1;
    },
  };
}
