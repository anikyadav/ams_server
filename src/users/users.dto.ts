import { createZodDto } from 'nestjs-zod';
import { createStaffSchema } from '../auth/auth.dto';

export const updateStaffSchema = createStaffSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one staff field to update',
  );

export class UpdateStaffDto extends createZodDto(updateStaffSchema) {}
