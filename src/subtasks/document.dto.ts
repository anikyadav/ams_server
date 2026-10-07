import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateDocumentSchema = z
  .strictObject({
    registrationNo: z.string().trim().max(200).nullable().optional(),
    userId: z.string().trim().max(200).nullable().optional(),
    password: z.string().min(1).max(1000).nullable().optional(),
    nextRenewalDate: z.iso.date().nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required',
  );

export class UpdateDocumentDto extends createZodDto(updateDocumentSchema) {}
export class RevealDocumentDto extends createZodDto(
  z.strictObject({
    token: z.string().min(1).max(2000),
    answer: z.number().int().min(0).max(100),
  }),
) {}
