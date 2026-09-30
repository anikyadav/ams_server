import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CreateStaffDto } from '../src/auth/auth.dto';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

// Test-only route verifies the same DTO + global pipe wiring used by business APIs.
@Controller('validation-test')
class ValidationController {
  @Post()
  create(@Body() body: CreateStaffDto) {
    return { name: body.name, email: body.email };
  }
}

describe('Backend foundation HTTP tests (database mocked)', () => {
  let app: INestApplication<App>;
  const query = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController, ValidationController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: query } },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = module.createNestApplication();
    setupApp(app, 'http://localhost:3000');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('reports database readiness', async () => {
    query.mockResolvedValueOnce([{ '?column?': 1 }]);
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
  });

  it('returns 503 without exposing database errors', async () => {
    query.mockRejectedValueOnce(new Error('private connection details'));
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(response.text).not.toContain('private connection details');
  });

  it('normalizes valid input through the global Zod pipe', async () => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({
        name: ' Staff ',
        email: ' STAFF@EXAMPLE.COM ',
        password: 'long-password-123',
      })
      .expect(201)
      .expect({ name: 'Staff', email: 'staff@example.com' });
  });

  it.each([
    { role: 'AUDITOR' },
    { name: ' ' },
    { email: 'invalid' },
    { password: 'short' },
    { password: '🙂'.repeat(19) },
  ])('rejects invalid or privilege-escalating input %j', async (override) => {
    await request(app.getHttpServer())
      .post('/validation-test')
      .send({
        name: 'Staff',
        email: 'staff@example.com',
        password: 'long-password-123',
        ...override,
      })
      .expect(400);
  });

  it('publishes Swagger JSON', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    expect(response.text).toContain('/health/ready');
    expect(response.text).toContain('CreateStaffDto');
  });
});
