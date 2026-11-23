import { z } from "zod";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i);
const empty = z.strictObject({});

export const projectTaskParams = z.strictObject({ projectId: objectId });
export const taskParams = z.strictObject({ taskId: objectId });
export const emptyTaskQuery = empty;
export const emptyTaskBody = empty.optional();

export const createTaskBody = z.strictObject({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(5000).optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueDate: z.iso.datetime({ offset: true }).transform(value => new Date(value)).nullable().optional(),
});

export const updateTaskBody = createTaskBody.partial().refine(fields => Object.keys(fields).length > 0);

function positiveInteger(max) {
  return z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max));
}

export const listTaskQuery = z.strictObject({
  page: positiveInteger(1000).default(1),
  limit: positiveInteger(100).default(20),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});
