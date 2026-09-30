import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const createCommentSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
});

const updateable = z.strictObject({
  text: z.string().trim().min(1).max(2000),
});

export const updateCommentSchema = updateable
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export class CreateCommentDto extends createZodDto(createCommentSchema) {}
export class UpdateCommentDto extends createZodDto(updateCommentSchema) {}
