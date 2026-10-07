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
  // A reason marks the task as blocked; null clears the flag.
  blockedReason: z.string().trim().min(1).max(300).nullable(),
});

export const updateSubTaskSchema = updateable
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export class CreateSubTaskDto extends createZodDto(createSubTaskSchema) {}
export class UpdateSubTaskDto extends createZodDto(updateSubTaskSchema) {}

export class ReviewSubTaskDto extends createZodDto(
  z
    .strictObject({
      decision: z.enum(['APPROVE', 'REQUEST_CHANGES']),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .refine((value) => value.decision === 'APPROVE' || !!value.note, {
      message: 'Explain what needs to change',
      path: ['note'],
    }),
) {}

export class CreateChecklistItemDto extends createZodDto(
  z.strictObject({ text: z.string().trim().min(1).max(300) }),
) {}

export class UpdateChecklistItemDto extends createZodDto(
  z
    .strictObject({
      done: z.boolean(),
      text: z.string().trim().min(1).max(300),
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field is required',
    }),
) {}
