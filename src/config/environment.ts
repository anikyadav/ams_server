import { z } from 'zod';

export const environmentSchema = z.object({
  IRD_CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, 'Must be a 32-byte hexadecimal key')
    .optional(),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  DATABASE_URL: z
    .url()
    .refine(
      (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
      'Must be a PostgreSQL connection URL',
    ),
  JWT_SECRET: z
    .string()
    .min(32)
    .refine(
      (value) => !value.startsWith('replace-with-'),
      'Replace the example JWT secret with a random secret',
    ),
  CORS_ORIGIN: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
    }, 'Must be an HTTP(S) origin without a trailing slash or path')
    .default('http://localhost:3000'),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    // Report field names and rules, never connection strings or secrets.
    throw new Error(
      `Invalid environment: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}
