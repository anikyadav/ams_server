import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const clientSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  pan: z
    .string()
    .trim()
    .regex(/^[0-9]{9}$/, 'PAN must contain exactly nine digits'),
  fileLocation: z.string().trim().min(1).max(1000),
  location: z.string().trim().max(1000).nullable().optional(),
});

export class CreateClientDto extends createZodDto(clientSchema) {}
export class UpdateClientDto extends createZodDto(
  clientSchema.partial().refine((input) => Object.keys(input).length > 0, {
    message: 'Provide at least one field to update',
  }),
) {}
