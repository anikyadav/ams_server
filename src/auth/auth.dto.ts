import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const emailSchema = z.email().trim().toLowerCase();
export const passwordSchema = z
  .string()
  .min(12)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= 72,
    'Password must not exceed 72 UTF-8 bytes',
  );

export const loginSchema = z.strictObject({
  email: z.string().trim().pipe(emailSchema),
  password: z.string().min(1).max(256),
});

export class LoginDto extends createZodDto(loginSchema) {}

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

export const createStaffSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().pipe(emailSchema),
  password: passwordSchema,
});

// Role is intentionally absent: the staff creation endpoint will set STAFF.
export class CreateStaffDto extends createZodDto(createStaffSchema) {}
