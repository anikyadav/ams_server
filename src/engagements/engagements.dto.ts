import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { EngagementStatus } from '../generated/prisma/client';

const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const engagementSchema = z.strictObject({
  clientId: z.string().trim().min(1),
  staffId: z.string().trim().min(1),
  natureOfWork: z.string().trim().min(1).max(2000),
  status: z.enum(EngagementStatus).optional(),
  startDate: date.nullable().optional(),
  targetDate: date.nullable().optional(),
  priority: z.string().trim().min(1).max(120).nullable().optional(),
});

export class CreateEngagementDto extends createZodDto(engagementSchema) {}
export class UpdateEngagementDto extends createZodDto(
  engagementSchema.partial().refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  }),
) {}

export class UpdateEngagementProgressDto extends createZodDto(
  z.strictObject({
    progress: z
      .number()
      .int()
      .refine((value) => [25, 50, 75, 100].includes(value), {
        message: 'Choose 25, 50, 75 or 100 percent',
      }),
    comment: z.string().trim().min(1).max(2000).optional(),
  }),
) {}

export class CloneEngagementsDto extends createZodDto(
  z.strictObject({
    sourceIds: z.array(z.string().trim().min(1)).min(1).max(100),
  }),
) {}
