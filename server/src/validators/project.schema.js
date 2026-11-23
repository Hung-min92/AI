import { z } from "zod";

export const createProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
});

export const updateProjectSchema = createProjectSchema.partial().refine(
  (fields) => Object.keys(fields).length > 0,
  "Provide at least one field to update.",
);

export const projectParamsSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{24}$/i),
});

function positiveInteger(max) {
  return z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max));
}

export const listProjectsSchema = z.strictObject({
  page: positiveInteger(1000).default(1),
  limit: positiveInteger(100).default(20),
  sort: z.enum(["newest", "oldest"]).default("newest"),
});
