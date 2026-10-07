import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DocumentRequestStatus } from '../generated/prisma/client';

export class CreateDocumentRequestDto extends createZodDto(
  z.strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2000).nullable().optional(),
    dueDate: z.iso.date().nullable().optional(),
  }),
) {}

export class UpdateDocumentRequestDto extends createZodDto(
  z
    .strictObject({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(2000).nullable(),
      dueDate: z.iso.date().nullable(),
      status: z.enum(DocumentRequestStatus),
      // Where the document was saved or how it was received (a file location, email, folder).
      reference: z.string().trim().min(1).max(500).nullable(),
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field is required',
    }),
) {}
