import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SubTaskStatus, TaskPriority } from '../generated/prisma/client';

const createSubTaskSchema = z.strictObject({
  dueDate: z.iso.date().nullable().optional(),
  priority: z.enum(TaskPriority).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000).nullable().optional(),
  assignedToId: z.string().trim().min(1),
});

const updateable = z.strictObject({
  comment: z.string().trim().min(1).max(2000),
  dueDate: z.iso.date().nullable().optional(),
  priority: z.enum(TaskPriority).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000).nullable(),
  status: z.enum(SubTaskStatus),
  progress: z
    .number()
    .int()
    .refine((value) => [0, 25, 50, 75, 100].includes(value), {
      message: 'Progress must be one of 0, 25, 50, 75 or 100',
    }),
  assignedToId: z.string().trim().min(1),
});

export const updateSubTaskSchema = updateable
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export class CreateSubTaskDto extends createZodDto(createSubTaskSchema) {}
export class UpdateSubTaskDto extends createZodDto(updateSubTaskSchema) {}
