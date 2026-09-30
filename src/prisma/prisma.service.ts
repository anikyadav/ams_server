import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { Environment } from '../config/environment';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<Environment, true>) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: config.get('DATABASE_URL', { infer: true }),
          connectionTimeoutMillis: 5000,
        },
        {
          schema:
            new URL(
              config.get('DATABASE_URL', { infer: true }),
            ).searchParams.get('schema') ?? 'public',
        },
      ),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
