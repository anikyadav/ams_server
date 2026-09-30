import 'dotenv/config';
import { hash } from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { z } from 'zod';

const seedEnvironment = z
  .object({
    NODE_ENV: z.enum(['development', 'test']).default('development'),
    DATABASE_URL: z.url(),
  })
  .parse(process.env);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: seedEnvironment.DATABASE_URL }),
});

async function seed() {
  const passwordHash = await hash('Audit123', 12);
  await prisma.$transaction(async (tx) => {
    await tx.fiscalYear.upsert({
      where: { id: 'legacy' },
      update: {},
      create: { id: 'legacy' },
    });
    await tx.user.upsert({
      where: { email: 'akylahan@gmail.com' },
      update: {},
      create: {
        name: 'Auditor',
        email: 'akylahan@gmail.com',
        role: 'AUDITOR',
        passwordHash,
      },
    });
  });
  console.log(
    'Default auditor seeded. Existing accounts and passwords were preserved.',
  );
}

seed()
  .catch(() => {
    console.error('Seed failed. Check database connectivity and migrations.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
