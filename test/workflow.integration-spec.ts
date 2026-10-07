import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';
import { Workbook } from 'exceljs';
import { randomBytes } from 'node:crypto';

process.env.IRD_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');

jest.setTimeout(60000);

describe('Real PostgreSQL API workflow (isolated schema)', () => {
  const schema = `test_api_${randomUUID().replaceAll('-', '')}`;
  const password = 'Test-password-12345';
  let app: INestApplication<App>;
  let db: Client;
  let prisma: PrismaService;
  let auditorId: string;
  let staffId: string;
  let otherId: string;
  let auditorToken: string;
  let staffToken: string;
  let otherToken: string;

  const server = () => app.getHttpServer();
  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error('DATABASE_URL is required for integration tests');
    db = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
    });
    await db.connect();
    await db.query('BEGIN');
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    const migrations = resolve(__dirname, '../prisma/migrations');
    for (const name of readdirSync(migrations)
      .filter((name) => /^\d/.test(name))
      .sort()) {
      const migration = readFileSync(
        resolve(migrations, name, 'migration.sql'),
        'utf8',
      );
      await db.query(migration.replaceAll('"public"', `"${schema}"`));
    }
    const url = new URL(process.env.DATABASE_URL);
    await db.query('COMMIT');
    url.searchParams.set('schema', schema);
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    setupApp(app, 'http://localhost:3000');
    await app.init();
    await prisma.fiscalYear.create({
      data: {
        id: 'fixture',
        startDate: new Date('2023-07-17'),
        endDate: new Date('2024-07-16'),
      },
    });
    const passwordHash = await hash(password, 12);
    auditorId = (
      await prisma.user.create({
        data: {
          name: 'Auditor',
          email: 'auditor@test.example',
          passwordHash,
          role: 'AUDITOR',
        },
      })
    ).id;
    staffId = (
      await prisma.user.create({
        data: {
          name: 'Staff',
          email: 'staff@test.example',
          passwordHash,
          role: 'STAFF',
        },
      })
    ).id;
    otherId = (
      await prisma.user.create({
        data: {
          name: 'Other',
          email: 'other@test.example',
          passwordHash,
          role: 'STAFF',
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (app) await app.close();
    else if (prisma) await prisma.$disconnect();
    if (db) {
      // Only the randomly generated schema belonging to this test run may be removed.
      if (!/^test_api_[a-f0-9]{32}$/.test(schema))
        throw new Error('Invalid cleanup schema');
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
  });

  describe('clients', () => {
    let token: string;
    let restrictedToken: string;

    beforeAll(async () => {
      for (const email of ['auditor', 'staff']) {
        const response = await request(server())
          .post('/auth/login')
          .send({ email: `${email}@test.example`, password })
          .expect(200);
        const accessToken = (response.body as { accessToken: string })
          .accessToken;
        if (email === 'auditor') token = accessToken;
        else restrictedToken = accessToken;
      }
    });

    it('creates, lists, reads, updates and deletes a client', async () => {
      const created = await request(server())
        .post('/clients')
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .send({
          name: ' Example Client ',
          pan: ' 012345678 ',
          fileLocation: ' Cabinet A / Shelf 2 ',
          location: ' Kathmandu, Nepal ',
        })
        .expect(201);
      const client = created.body as { id: string; name: string };
      expect(client).toMatchObject({
        name: 'Example Client',
        pan: '012345678',
        fileLocation: 'Cabinet A / Shelf 2',
        location: 'Kathmandu, Nepal',
      });
      const list = await request(server())
        .get('/clients')
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .expect(200);
      expect(list.body).toContainEqual(created.body);
      const detail = await request(server())
        .get(`/clients/${client.id}`)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .expect(200);
      expect(detail.body).toEqual(created.body);
      const updated = await request(server())
        .patch(`/clients/${client.id}`)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .send({ name: ' Updated Client ' })
        .expect(200);
      expect(updated.body).toMatchObject({
        id: client.id,
        name: 'Updated Client',
        pan: '012345678',
        fileLocation: 'Cabinet A / Shelf 2',
        location: 'Kathmandu, Nepal',
      });
      await request(server())
        .patch(`/clients/${client.id}`)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .send({
          pan: '987654321',
          fileLocation: 'Cabinet B',
          location: 'Pokhara',
        })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            name: 'Updated Client',
            pan: '987654321',
            fileLocation: 'Cabinet B',
            location: 'Pokhara',
          }),
        );
      await request(server())
        .patch(`/clients/${client.id}`)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .send({ location: null })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            pan: '987654321',
            fileLocation: 'Cabinet B',
            location: null,
          }),
        );
      const removed = await request(server())
        .delete(`/clients/${client.id}`)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .expect(204);
      expect(removed.text).toBe('');
      for (const method of ['get', 'patch', 'delete'] as const) {
        await request(server())
          [method](`/clients/${client.id}`)
          .set('Authorization', bearer(token))
          .set('X-Fiscal-Year-Id', 'fixture')
          .send(method === 'patch' ? { name: 'Missing' } : undefined)
          .expect(404);
      }
    });

    it('requires name, PAN and file location when creating a client', async () => {
      const input = {
        name: 'Required fields',
        pan: '012345678',
        fileLocation: 'Shelf A',
      };
      for (const field of ['name', 'pan', 'fileLocation'] as const) {
        const incomplete: Partial<typeof input> = { ...input };
        delete incomplete[field];
        await request(server())
          .post('/clients')
          .set('Authorization', bearer(token))
          .set('X-Fiscal-Year-Id', 'fixture')
          .send(incomplete)
          .expect(400);
      }
    });

    it('rejects invalid names, empty updates and extra fields without changing records', async () => {
      const client = await prisma.client.create({
        data: {
          fiscalYearId: 'fixture',
          name: 'Unchanged',
          pan: '123456789',
          fileLocation: 'Test shelf',
        },
      });
      for (const input of [
        {},
        { name: ' ' },
        { name: null },
        { name: 123 },
        { name: 'a'.repeat(121) },
        { name: 'Valid', id: 'injected' },
        ...['', '12345678', '1234567890', '12345678a', 123456789].map(
          (pan) => ({ name: 'Valid', pan }),
        ),
        { name: 'Valid', fileLocation: 123 },
        { pan: null },
        { fileLocation: null },
        { fileLocation: '' },
        { fileLocation: '   ' },
        { name: 'Valid', fileLocation: 'a'.repeat(1001) },
        { name: 'Valid', location: 123 },
        { name: 'Valid', location: 'a'.repeat(1001) },
      ]) {
        await request(server())
          .post('/clients')
          .set('Authorization', bearer(token))
          .set('X-Fiscal-Year-Id', 'fixture')
          .send(input)
          .expect(400);
        await request(server())
          .patch(`/clients/${client.id}`)
          .set('Authorization', bearer(token))
          .set('X-Fiscal-Year-Id', 'fixture')
          .send(input)
          .expect(400);
      }
      expect(
        await prisma.client.findUniqueOrThrow({ where: { id: client.id } }),
      ).toMatchObject({ name: 'Unchanged' });
    });

    it('denies anonymous and staff access to every client route', async () => {
      const client = await prisma.client.create({
        data: {
          fiscalYearId: 'fixture',
          name: 'Protected',
          pan: '123456789',
          fileLocation: 'Test shelf',
        },
      });
      const routes = [
        ['get', '/clients'],
        ['post', '/clients'],
        ['get', `/clients/${client.id}`],
        ['patch', `/clients/${client.id}`],
        ['delete', `/clients/${client.id}`],
      ] as const;
      for (const [method, path] of routes) {
        await request(server())
          [method](path)
          .send({ name: 'Unauthorized' })
          .expect(401);
        await request(server())
          [method](path)
          .set('Authorization', bearer(restrictedToken))
          .set('X-Fiscal-Year-Id', 'fixture')
          .send({ name: 'Unauthorized' })
          .expect(403);
      }
      expect(
        await prisma.client.findUniqueOrThrow({ where: { id: client.id } }),
      ).toMatchObject({ name: 'Protected' });
    });

    it('rejects deleting a client with engagements and preserves both records', async () => {
      const client = await prisma.client.create({
        data: {
          fiscalYearId: 'fixture',
          name: 'Active Client',
          pan: '123456789',
          fileLocation: 'Test shelf',
        },
      });
      const engagement = await prisma.engagement.create({
        data: {
          fiscalYearId: 'fixture',
          clientId: client.id,
          staffId,
          natureOfWork: 'Audit',
        },
      });
      await request(server())
        .delete(`/clients/${client.id}`)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'fixture')
        .expect(409);
      expect(
        await prisma.client.findUnique({ where: { id: client.id } }),
      ).not.toBeNull();
      expect(
        await prisma.engagement.findUnique({ where: { id: engagement.id } }),
      ).not.toBeNull();
    });
  });

  describe('engagements', () => {
    let token: string;
    let workerToken: string;
    let clientId: string;
    const call = (
      method: 'get' | 'post' | 'patch' | 'delete',
      path: string,
      auth = token,
    ) =>
      request(server())
        [method](path)
        .set('Authorization', bearer(auth))
        .set('X-Fiscal-Year-Id', 'fixture');
    const create = async (staff = staffId, keepTemplates = false) => {
      const response = await call('post', '/engagements')
        .send({
          clientId,
          staffId: staff,
          natureOfWork: ' Annual audit ',
          startDate: '2026-01-01',
          targetDate: '2026-12-31',
        })
        .expect(201);
      const record = response.body as {
        id: string;
        progress: number;
        natureOfWork: string;
        subTasks: {
          id: string;
          templateKey: string;
          title: string;
          sortOrder: number;
          assignedToId: string;
        }[];
      };
      // Existing cases exercise custom-task/empty-task scenarios deliberately.
      if (!keepTemplates)
        await prisma.subTask.deleteMany({ where: { engagementId: record.id } });
      return record;
    };

    beforeAll(async () => {
      for (const email of ['auditor', 'staff']) {
        const response = await request(server())
          .post('/auth/login')
          .send({ email: `${email}@test.example`, password })
          .expect(200);
        const value = (response.body as { accessToken: string }).accessToken;
        if (email === 'auditor') token = value;
        else workerToken = value;
      }
      clientId = (
        await prisma.client.create({
          data: {
            fiscalYearId: 'fixture',
            name: 'Engagement Client',
            pan: '123456789',
            fileLocation: 'Test shelf',
          },
        })
      ).id;
    });

    it('creates six ordered compulsory tasks and shares client IRD credentials across engagements', async () => {
      const first = await create(staffId, true);
      expect(first.subTasks.map((task) => task.title)).toEqual([
        'Document',
        'Vat Reco',
        'Sales Reco',
        'Purchase Reco',
        'Sales Confirmation',
        'Purchase Confirmation',
      ]);
      expect(first.subTasks.map((task) => task.sortOrder)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(
        first.subTasks.every((task) => task.assignedToId === staffId),
      ).toBe(true);
      const docId = first.subTasks[0].id;
      await call('delete', `/subtasks/${docId}`).expect(400);
      const creationActivity = await call(
        'get',
        `/subtasks/${docId}/activity`,
      ).expect(200);
      expect(creationActivity.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'SUBTASK_CREATED' }),
        ]),
      );
      await call('get', `/engagements/${first.id}/subtasks`)
        .expect(200)
        .expect((res) => {
          expect(
            (res.body as { sortOrder: number }[]).map((task) => task.sortOrder),
          ).toEqual([1, 2, 3, 4, 5, 6]);
        });
      const path = `/subtasks/${docId}/document`;
      const secret = '=secret-001+"test"';
      const saved = await call('patch', path, workerToken)
        .send({
          registrationNo: '00123',
          userId: '000987',
          password: secret,
          nextRenewalDate: '2026-10-07',
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        registrationNo: '00123',
        userId: '000987',
        hasPassword: true,
        nextRenewalDate: '2026-10-07T00:00:00.000Z',
      });
      expect(saved.text).not.toContain(secret);
      expect(saved.text).not.toContain('passwordEncrypted');
      const stored = await prisma.clientIrdCredential.findUniqueOrThrow({
        where: { clientId },
      });
      expect(stored.passwordEncrypted).not.toContain(secret);
      const docActivity = await call(
        'get',
        `/subtasks/${docId}/activity`,
        workerToken,
      ).expect(200);
      expect(docActivity.text).toContain('1.1 Registration No.');
      expect(docActivity.text).toContain('1.2 IRD user ID');
      expect(docActivity.text).toContain('1.3 IRD password');
      expect(docActivity.text).toContain('1.4 Next renewal date');
      expect(docActivity.text).not.toContain(secret);
      expect(docActivity.text).not.toContain('000987');
      const second = await create(staffId, true);
      await call('get', `/subtasks/${second.subTasks[0].id}/document`)
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            userId: '000987',
            hasPassword: true,
          }),
        );
      const ordinary = await call('get', `/engagements/${first.id}`).expect(
        200,
      );
      expect(ordinary.text).not.toContain(secret);
      expect(ordinary.text).not.toContain('passwordEncrypted');
      await call('patch', path).send({ registrationNo: '00456' }).expect(200);
      const challenge = await call('post', `${path}/challenge`, workerToken)
        .send({})
        .expect(201);
      const value = challenge.body as { token: string; question: string };
      const answer = value.question
        .split(' + ')
        .map(Number)
        .reduce((a, b) => a + b, 0);
      await call('post', `${path}/reveal`, workerToken)
        .send({ token: value.token, answer: answer + 1 })
        .expect(400);
      await call('post', `${path}/reveal`)
        .send({ token: value.token, answer })
        .expect(400);
      await call('post', `${path}/reveal`, workerToken)
        .send({ token: value.token, answer })
        .expect(201)
        .expect((res) => expect(res.body).toEqual({ password: secret }));
      await prisma.subTask.update({
        where: { id: docId },
        data: { assignedToId: otherId },
      });
      await call('get', path, workerToken).expect(404);
      await call('patch', path, workerToken)
        .send({ password: 'blocked' })
        .expect(404);
      await call('post', `${path}/reveal`, workerToken)
        .send({ token: value.token, answer })
        .expect(404);
      await request(server())
        .get(path)
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'legacy')
        .expect(404);
      await call('patch', `/clients/${clientId}/ird-credentials`)
        .send({ password: null, userId: null, nextRenewalDate: null })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            hasPassword: false,
            userId: null,
            nextRenewalDate: null,
          }),
        );
      await call('delete', `/engagements/${first.id}`).expect(204);
      await call('delete', `/engagements/${second.id}`).expect(204);
      expect(
        await prisma.clientIrdCredential.count({ where: { clientId } }),
      ).toBe(1);
    });

    it('exports exact IRD credentials only for the selected fiscal year and only for auditors', async () => {
      const secret = '=IRD-secret-0123';
      await call('patch', `/clients/${clientId}/ird-credentials`)
        .send({ userId: '0000123', password: secret })
        .expect(200);
      const challenge = await call(
        'post',
        '/clients/ird-credentials/export/challenge',
      )
        .send({})
        .expect(201);
      const value = challenge.body as { token: string; question: string };
      const answer = value.question
        .split(' + ')
        .map(Number)
        .reduce((a, b) => a + b, 0);
      await call(
        'post',
        '/clients/ird-credentials/export/challenge',
        workerToken,
      )
        .send({})
        .expect(403);
      await call('post', '/clients/ird-credentials/export', workerToken)
        .send({ token: value.token, answer })
        .expect(403);
      await call('post', '/clients/ird-credentials/export')
        .send({ token: value.token, answer: answer + 1 })
        .expect(400);
      await request(server())
        .post('/clients/ird-credentials/export')
        .set('Authorization', bearer(token))
        .set('X-Fiscal-Year-Id', 'legacy')
        .send({ token: value.token, answer })
        .expect(400);
      const result = await call('post', '/clients/ird-credentials/export')
        .send({ token: value.token, answer })
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(201);
      expect(result.headers['cache-control']).toBe('no-store');
      const workbook = new Workbook();
      await workbook.xlsx.load(
        result.body as Parameters<typeof workbook.xlsx.load>[0],
      );
      const sheet = workbook.getWorksheet('IRD credentials')!;
      const row = sheet
        .getRows(2, sheet.rowCount - 1)!
        .find((item) => item.getCell(1).value === 'Engagement Client')!;
      expect(row.getCell(2).value).toBe('0000123');
      expect(row.getCell(3).value).toBe(secret);
      expect(row.getCell(3).type).toBe(3); // String, never an Excel formula.
      expect(sheet.rowCount - 1).toBe(
        await prisma.client.count({ where: { fiscalYearId: 'fixture' } }),
      );
      expect(
        await prisma.irdCredentialAccessLog.count({
          where: {
            fiscalYearId: 'fixture',
            actorId: auditorId,
            action: 'IRD_CREDENTIALS_EXPORTED',
          },
        }),
      ).toBe(1);
    });

    it('updates assigned engagement milestones without subtasks and shares completion with auditor', async () => {
      const engagement = await create();
      for (const progress of [25, 50, 75, 100]) {
        const result = await call(
          'patch',
          `/engagements/${engagement.id}/progress`,
          workerToken,
        )
          .send({ progress, comment: `Completed ${progress}%` })
          .expect(200);
        expect(result.body).toMatchObject({
          progress,
          status: progress === 100 ? 'COMPLETE' : 'IN_PROGRESS',
          subTasks: [],
        });
      }
      for (const auth of [token, workerToken]) {
        const result = await call('get', '/engagements', auth).expect(200);
        expect(result.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: engagement.id,
              status: 'COMPLETE',
              progress: 100,
            }),
          ]),
        );
      }
      const detail = await call('get', `/engagements/${engagement.id}`).expect(
        200,
      );
      expect(detail.body.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorId: staffId,
            text: 'Engagement progress updated to 100% (Complete).\nCompleted 100%',
          }),
        ]),
      );
      const other = await create(otherId);
      await call('patch', `/engagements/${other.id}/progress`, workerToken)
        .send({ progress: 100 })
        .expect(404);
      await call('patch', `/engagements/${engagement.id}/progress`, workerToken)
        .send({ progress: 60 })
        .expect(400);
      await call('patch', `/engagements/${engagement.id}/progress`, workerToken)
        .send({ progress: 50, staffId: otherId })
        .expect(400);
      await call('patch', `/engagements/${engagement.id}/progress`, workerToken)
        .send({ progress: 75 })
        .expect(200);
      const reopened = await call(
        'get',
        `/engagements/${engagement.id}`,
      ).expect(200);
      expect(reopened.body).toMatchObject({
        status: 'IN_PROGRESS',
        progress: 75,
      });
    });

    it('creates, reads, lists, updates and deletes with missing-resource responses', async () => {
      const created = await create();
      expect(created).toMatchObject({
        natureOfWork: 'Annual audit',
        progress: 0,
      });
      const detail = await call('get', `/engagements/${created.id}`).expect(
        200,
      );
      expect(detail.body).toMatchObject({
        client: { id: clientId },
        staff: { id: staffId },
      });
      expect(detail.text).not.toContain('passwordHash');
      const list = await call('get', '/engagements').expect(200);
      expect(list.body).toContainEqual(detail.body);
      const changed = await call('patch', `/engagements/${created.id}`)
        .send({
          natureOfWork: ' Revised audit ',
          status: 'UNDER_REVIEW',
          priority: ' High ',
        })
        .expect(200);
      expect(changed.body).toMatchObject({
        natureOfWork: 'Revised audit',
        status: 'UNDER_REVIEW',
        priority: 'High',
      });
      const removed = await call('delete', `/engagements/${created.id}`).expect(
        204,
      );
      expect(removed.text).toBe('');
      for (const method of ['get', 'patch', 'delete'] as const)
        await call(method, `/engagements/${created.id}`)
          .send(method === 'patch' ? { status: 'COMPLETE' } : undefined)
          .expect(404);
    });

    it('scopes reads to primary or subtask assignments and immediately reflects reassignment', async () => {
      const primary = await create();
      const secondary = await create(otherId);
      const hidden = await create(otherId);
      const task = await prisma.subTask.create({
        data: {
          engagementId: secondary.id,
          assignedToId: staffId,
          title: 'Assigned task',
        },
      });
      await call('get', `/engagements/${primary.id}`, workerToken).expect(200);
      await call('get', `/engagements/${secondary.id}`, workerToken).expect(
        200,
      );
      await call('get', `/engagements/${hidden.id}`, workerToken).expect(404);
      const list = await call('get', '/engagements', workerToken).expect(200);
      const ids = (list.body as { id: string }[]).map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([primary.id, secondary.id]));
      expect(ids).not.toContain(hidden.id);
      await call('patch', `/engagements/${primary.id}`)
        .send({ staffId: otherId })
        .expect(200);
      await call('get', `/engagements/${primary.id}`, workerToken).expect(404);
      // Primary reassignment must not remove access granted by a subtask.
      await call('patch', `/engagements/${secondary.id}`)
        .send({ staffId: staffId })
        .expect(200);
      await call('patch', `/engagements/${secondary.id}`)
        .send({ staffId: otherId })
        .expect(200);
      await call('get', `/engagements/${secondary.id}`, workerToken).expect(
        200,
      );
      await prisma.subTask.update({
        where: { id: task.id },
        data: { assignedToId: otherId },
      });
      await call('get', `/engagements/${secondary.id}`, workerToken).expect(
        404,
      );
      const after = await call('get', '/engagements', workerToken).expect(200);
      expect((after.body as { id: string }[]).map((row) => row.id)).not.toEqual(
        expect.arrayContaining([secondary.id]),
      );
    });

    it('rejects anonymous access and staff mutations even on assigned engagements', async () => {
      const engagement = await create();
      for (const [method, path] of [
        ['get', '/engagements'],
        ['get', `/engagements/${engagement.id}`],
        ['post', '/engagements'],
        ['patch', `/engagements/${engagement.id}`],
        ['delete', `/engagements/${engagement.id}`],
      ] as const) {
        await request(server())
          [method](path)
          .send({ status: 'COMPLETE' })
          .expect(401);
        if (method !== 'get')
          await call(method, path, workerToken)
            .send({ status: 'COMPLETE' })
            .expect(403);
      }
    });

    it('validates references, roles, strict fields and effective dates on partial updates', async () => {
      const engagement = await create();
      for (const input of [
        { clientId: 'missing' },
        { staffId: 'missing' },
        { staffId: auditorId },
        { natureOfWork: ' ' },
        { status: 'INVALID' },
        { priority: '' },
        { startDate: '2026-02-30' },
        { targetDate: 'invalid' },
        { startDate: '2027-01-01' },
        { targetDate: '2025-12-31' },
        { progress: 100 },
      ]) {
        await call('post', '/engagements')
          .send({
            clientId,
            staffId,
            natureOfWork: 'Audit',
            startDate: '2026-01-01',
            targetDate: '2026-12-31',
            ...input,
          })
          .expect(400);
        await call('patch', `/engagements/${engagement.id}`)
          .send(input)
          .expect(400);
      }
      await call('patch', `/engagements/${engagement.id}`).send({}).expect(400);
      const cleared = await call('patch', `/engagements/${engagement.id}`)
        .send({ startDate: null, targetDate: null, priority: null })
        .expect(200);
      expect(cleared.body).toMatchObject({
        startDate: null,
        targetDate: null,
        priority: null,
      });
      await call('patch', `/engagements/${engagement.id}`)
        .send({
          startDate: '2026-09-17T08:00:00+05:45',
          targetDate: '2026-09-17T03:00:00Z',
        })
        .expect(200);
    });

    it('includes all visible subtasks/comments, computes progress, and cascades deletion', async () => {
      const engagement = await create();
      const tasks = await Promise.all(
        ['DONE', 'TODO', 'IN_PROGRESS'].map((status, index) =>
          prisma.subTask.create({
            data: {
              engagementId: engagement.id,
              assignedToId: otherId,
              title: status,
              status: status as 'DONE' | 'TODO' | 'IN_PROGRESS',
              progress: index === 0 ? 100 : 0,
            },
          }),
        ),
      );
      await prisma.comment.create({
        data: {
          engagementId: engagement.id,
          subTaskId: tasks[0].id,
          authorId: auditorId,
          text: 'Task comment',
        },
      });
      await prisma.comment.create({
        data: {
          engagementId: engagement.id,
          authorId: otherId,
          text: 'Engagement comment',
        },
      });
      const detail = await call(
        'get',
        `/engagements/${engagement.id}`,
        workerToken,
      ).expect(200);
      const body = detail.body as {
        progress: number;
        status: string;
        subTasks: unknown[];
        comments: unknown[];
      };
      expect(body.progress).toBe(33);
      expect(body.status).toBe('NOT_STARTED');
      expect(body.subTasks).toHaveLength(3);
      expect(body.comments).toHaveLength(2);
      expect(detail.text).not.toContain('passwordHash');
      await call('delete', `/engagements/${engagement.id}`).expect(204);
      expect(
        await prisma.subTask.count({ where: { engagementId: engagement.id } }),
      ).toBe(0);
      expect(
        await prisma.comment.count({ where: { engagementId: engagement.id } }),
      ).toBe(0);
      expect(
        await prisma.client.findUnique({ where: { id: clientId } }),
      ).not.toBeNull();
    });
  });

  describe('subtasks and comments', () => {
    let token: string;
    let workerToken: string;
    let clientId: string;
    const call = (
      method: 'get' | 'post' | 'patch' | 'delete',
      path: string,
      auth = token,
    ) =>
      request(server())
        [method](path)
        .set('Authorization', bearer(auth))
        .set('X-Fiscal-Year-Id', 'fixture');
    const createEngagement = async (staff = staffId) => {
      const response = await call('post', '/engagements')
        .send({
          clientId,
          staffId: staff,
          natureOfWork: 'Workflow audit',
        })
        .expect(201);
      const record = response.body as { id: string };
      // Isolate the custom-task scenarios below from automatic templates.
      await prisma.subTask.deleteMany({ where: { engagementId: record.id } });
      return record;
    };
    const createSubTask = async (
      engagementId: string,
      assignedTo = staffId,
      title = 'Collect evidence',
    ) => {
      const response = await call(
        'post',
        `/engagements/${engagementId}/subtasks`,
      )
        .send({ title, assignedToId: assignedTo })
        .expect(201);
      return response.body as {
        id: string;
        engagementId: string;
        title: string;
        status: string;
        progress: number;
      };
    };

    beforeAll(async () => {
      for (const email of ['auditor', 'staff']) {
        const response = await request(server())
          .post('/auth/login')
          .send({ email: `${email}@test.example`, password })
          .expect(200);
        const value = (response.body as { accessToken: string }).accessToken;
        if (email === 'auditor') token = value;
        else workerToken = value;
      }
      clientId = (
        await prisma.client.create({
          data: {
            fiscalYearId: 'fixture',
            name: 'Subtasks Client',
            pan: '123456789',
            fileLocation: 'Test shelf',
          },
        })
      ).id;
    });

    it('persists task planning fields, validates dates and protects them from staff edits', async () => {
      const engagement = await createEngagement();
      const created = await call(
        'post',
        `/engagements/${engagement.id}/subtasks`,
      )
        .send({
          title: 'Plan evidence',
          assignedToId: staffId,
          dueDate: '2026-10-01',
          priority: 'URGENT',
        })
        .expect(201);
      const task = created.body as { id: string };
      const detail = await call('get', `/engagements/${engagement.id}`).expect(
        200,
      );
      expect(detail.body).toMatchObject({
        subTasks: expect.arrayContaining([
          expect.objectContaining({
            id: task.id,
            dueDate: '2026-10-01T00:00:00.000Z',
            priority: 'URGENT',
          }),
        ]),
      });
      for (const input of [
        { dueDate: '2026-02-30' },
        { priority: 'INVALID' },
        { engagementId: 'other' },
      ]) {
        await call('patch', `/subtasks/${task.id}`).send(input).expect(400);
      }
      for (const input of [{ dueDate: null }, { priority: 'LOW' }]) {
        await call('patch', `/subtasks/${task.id}`, workerToken)
          .send(input)
          .expect(403);
      }
      await call('patch', `/subtasks/${task.id}`)
        .send({ title: 'Renamed task' })
        .expect(200);
      expect(
        await prisma.subTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ priority: 'URGENT', dueDate: new Date('2026-10-01') });
      await call('patch', `/subtasks/${task.id}`)
        .send({ dueDate: null, priority: 'LOW' })
        .expect(200);
      expect(
        await prisma.subTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ dueDate: null, priority: 'LOW' });
    });

    it('creates, lists, updates and deletes subtasks with missing-resource responses', async () => {
      const engagement = await createEngagement();
      const created = await createSubTask(
        engagement.id,
        staffId,
        ' Collect records ',
      );
      expect(created).toMatchObject({
        engagementId: engagement.id,
        title: 'Collect records',
        status: 'TODO',
        progress: 0,
        assignedTo: { id: staffId, role: 'STAFF' },
      });
      const list = await call(
        'get',
        `/engagements/${engagement.id}/subtasks`,
      ).expect(200);
      expect(list.body).toContainEqual(created);
      const updated = await call('patch', `/subtasks/${created.id}`)
        .send({
          title: 'Revised records',
          status: 'IN_PROGRESS',
          progress: 75,
          assignedToId: otherId,
        })
        .expect(200);
      expect(updated.body).toMatchObject({
        id: created.id,
        title: 'Revised records',
        status: 'IN_PROGRESS',
        progress: 75,
        assignedTo: { id: otherId, role: 'STAFF' },
      });
      await call('delete', `/subtasks/${created.id}`).expect(204);
      for (const method of ['patch', 'delete'] as const)
        await call(method, `/subtasks/${created.id}`)
          .send(method === 'patch' ? { status: 'DONE' } : undefined)
          .expect(404);
    });

    it('rejects invalid input, non-STAFF assignees and missing engagements without changing records', async () => {
      const engagement = await createEngagement();
      for (const input of [
        {},
        { title: ' ', assignedToId: staffId },
        { title: 'Missing assignee' },
        { title: 'Missing user', assignedToId: 'no-such-user' },
        { title: 'Auditor assignee', assignedToId: auditorId },
        { title: 'a'.repeat(201), assignedToId: staffId },
        { title: 'Extra status', assignedToId: staffId, status: 'DONE' },
        { title: 'With progress', assignedToId: staffId, progress: 50 },
      ]) {
        await call('post', `/engagements/${engagement.id}/subtasks`)
          .send(input)
          .expect(400);
      }
      await call('post', '/engagements/missing/subtasks')
        .send({ title: 'Orphan', assignedToId: staffId })
        .expect(404);
      expect(
        await prisma.subTask.count({ where: { engagementId: engagement.id } }),
      ).toBe(0);
      const task = await createSubTask(engagement.id, staffId);
      for (const input of [
        {},
        { title: ' ' },
        { description: '' },
        { status: 'INVALID' },
        { progress: 10 },
        { progress: null },
        { progress: '50' },
        { title: 'Valid', unexpected: true },
      ]) {
        await call('patch', `/subtasks/${task.id}`).send(input).expect(400);
      }
      expect(
        await prisma.subTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ title: 'Collect evidence', status: 'TODO' });
    });

    it('allows staff to update only status or progress on their assigned subtasks', async () => {
      const engagement = await createEngagement();
      const task = await createSubTask(engagement.id, staffId);
      const statusOnly = await call(
        'patch',
        `/subtasks/${task.id}`,
        workerToken,
      )
        .send({ status: 'DONE' })
        .expect(200);
      expect(statusOnly.body).toMatchObject({
        id: task.id,
        status: 'DONE',
        progress: 100,
      });
      const milestone = await call('patch', `/subtasks/${task.id}`, workerToken)
        .send({ progress: 50 })
        .expect(200);
      expect(milestone.body).toMatchObject({
        id: task.id,
        status: 'IN_PROGRESS',
        progress: 50,
      });
      const backToStart = await call(
        'patch',
        `/subtasks/${task.id}`,
        workerToken,
      )
        .send({ progress: 0 })
        .expect(200);
      expect(backToStart.body).toMatchObject({
        id: task.id,
        status: 'TODO',
        progress: 0,
      });
      for (const input of [
        { title: 'Rename' },
        { assignedToId: otherId },
        { status: 'TODO', title: 'Rename' },
        { status: 'DONE', progress: 75 },
      ]) {
        await call('patch', `/subtasks/${task.id}`, workerToken)
          .send(input)
          .expect(403);
      }
      await call('patch', `/subtasks/${task.id}`, workerToken)
        .send({ progress: 10 })
        .expect(400);
      await call('patch', `/subtasks/${task.id}`, workerToken)
        .send({})
        .expect(400);
    });

    it('shares milestone history, completion and replies across staff and auditor views', async () => {
      const engagement = await createEngagement();
      const task = await createSubTask(engagement.id);
      for (const progress of [25, 50, 75, 100]) {
        await call('patch', `/subtasks/${task.id}`, workerToken)
          .send({ progress, comment: `Evidence reviewed at ${progress}%` })
          .expect(200);
      }
      for (const auth of [token, workerToken]) {
        const response = await call(
          'get',
          `/engagements/${engagement.id}`,
          auth,
        ).expect(200);
        expect(response.body).toMatchObject({
          progress: 100,
          subTasks: [
            expect.objectContaining({
              id: task.id,
              status: 'DONE',
              progress: 100,
            }),
          ],
          comments: expect.arrayContaining([
            expect.objectContaining({
              subTaskId: task.id,
              authorId: staffId,
              text: 'Progress updated to 100% (Complete).\nEvidence reviewed at 100%',
            }),
          ]),
        });
      }
      await call('post', `/subtasks/${task.id}/comments`)
        .send({ text: 'Please revisit the evidence' })
        .expect(201);
      const staffView = await call(
        'get',
        `/engagements/${engagement.id}`,
        workerToken,
      ).expect(200);
      expect(staffView.body.comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: 'Please revisit the evidence',
            authorId: auditorId,
          }),
        ]),
      );
      await call('patch', `/subtasks/${task.id}`)
        .send({ status: 'IN_PROGRESS' })
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({ status: 'IN_PROGRESS', progress: 25 }),
        );
      const before = await prisma.comment.count({
        where: { subTaskId: task.id },
      });
      await call('patch', `/subtasks/${task.id}`)
        .send({ status: 'DONE', progress: 50, comment: 'Invalid' })
        .expect(400);
      expect(
        await prisma.comment.count({ where: { subTaskId: task.id } }),
      ).toBe(before);
    });

    it('limits non-primary staff to their own tasks and notifies assignees', async () => {
      const engagement = await createEngagement(otherId);
      const mine = await createSubTask(engagement.id, staffId, 'My task');
      await createSubTask(engagement.id, otherId, 'Colleague task');

      const staffView = await call(
        'get',
        `/engagements/${engagement.id}`,
        workerToken,
      ).expect(200);
      const visible = staffView.body as {
        subTasks: { id: string }[];
        comments: { subTaskId: string | null }[];
      };
      expect(visible.subTasks.map((task) => task.id)).toEqual([mine.id]);

      const primaryLogin = await request(server())
        .post('/auth/login')
        .send({ email: 'other@test.example', password })
        .expect(200);
      const primaryToken = (primaryLogin.body as { accessToken: string })
        .accessToken;
      const primaryView = await call(
        'get',
        `/engagements/${engagement.id}`,
        primaryToken,
      ).expect(200);
      expect(
        (primaryView.body as { subTasks: unknown[] }).subTasks,
      ).toHaveLength(2);

      await call('get', `/subtasks/${mine.id}`, workerToken).expect(200);
      await call('get', `/subtasks/${mine.id}/activity`, workerToken).expect(
        200,
      );

      const inbox = await call('get', '/notifications', workerToken).expect(
        200,
      );
      const body = inbox.body as {
        unreadCount: number;
        items: { id: string; type: string; subTaskId: string | null }[];
      };
      expect(body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'TASK_ASSIGNED',
            subTaskId: mine.id,
          }),
        ]),
      );
      expect(body.unreadCount).toBeGreaterThan(0);
      await call('post', '/notifications/read-all', workerToken).expect(204);
      const after = await call('get', '/notifications', workerToken).expect(
        200,
      );
      expect((after.body as { unreadCount: number }).unreadCount).toBe(0);
    });

    it('denies staff subtask creation/deletion and hides other staff subtasks', async () => {
      const engagement = await createEngagement(otherId);
      const hidden = await createSubTask(engagement.id, otherId);
      await call('patch', `/subtasks/${hidden.id}`, workerToken)
        .send({ status: 'DONE' })
        .expect(404);
      await call('delete', `/subtasks/${hidden.id}`, workerToken).expect(403);
      const ownList = await call(
        'get',
        `/engagements/${engagement.id}/subtasks`,
        workerToken,
      ).expect(200);
      expect(ownList.body).toEqual([]);
      await call('post', `/engagements/${engagement.id}/subtasks`, workerToken)
        .send({ title: 'Intrusion', assignedToId: staffId })
        .expect(403);
      await request(server())
        .post(`/engagements/${engagement.id}/subtasks`)
        .send({ title: 'Anonymous', assignedToId: staffId })
        .expect(401);
    });

    it('recomputes progress from subtask mutations and cascades subtask deletion', async () => {
      const engagement = await createEngagement();
      const stageA = await createSubTask(engagement.id, staffId, 'Stage A');
      const stageB = await createSubTask(engagement.id, staffId, 'Stage B');
      const initial = await call('get', `/engagements/${engagement.id}`).expect(
        200,
      );
      expect((initial.body as { progress: number }).progress).toBe(0);
      await call('patch', `/subtasks/${stageA.id}`, workerToken)
        .send({ status: 'DONE' })
        .expect(200);
      const done = await call('get', `/engagements/${engagement.id}`).expect(
        200,
      );
      expect((done.body as { progress: number }).progress).toBe(50);
      await call('delete', `/subtasks/${stageA.id}`).expect(204);
      const reduced = await call('get', `/engagements/${engagement.id}`).expect(
        200,
      );
      expect((reduced.body as { progress: number }).progress).toBe(0);
      expect(stageB.id).toBeTruthy();
    });

    it('creates and lists engagement and subtask comments for visible actors', async () => {
      const engagement = await createEngagement();
      const task = await createSubTask(engagement.id, staffId);
      const byAuditor = await call(
        'post',
        `/engagements/${engagement.id}/comments`,
      )
        .send({ text: ' Auditor note ' })
        .expect(201);
      expect(byAuditor.body).toMatchObject({
        engagementId: engagement.id,
        subTaskId: null,
        text: 'Auditor note',
        author: { id: auditorId, role: 'AUDITOR' },
      });
      const byStaff = await call(
        'post',
        `/engagements/${engagement.id}/comments`,
        workerToken,
      )
        .send({ text: 'Staff note' })
        .expect(201);
      const onTask = await call(
        'post',
        `/subtasks/${task.id}/comments`,
        workerToken,
      )
        .send({ text: 'On task' })
        .expect(201);
      expect(onTask.body).toMatchObject({
        engagementId: engagement.id,
        subTaskId: task.id,
        author: { id: staffId, role: 'STAFF' },
      });
      await call('post', `/engagements/${engagement.id}/comments`)
        .send({ text: 'Injected', engagementId: 'injected' })
        .expect(400);
      const list = await call(
        'get',
        `/engagements/${engagement.id}/comments`,
      ).expect(200);
      expect(list.body).toHaveLength(3);
      expect((list.body as { id: string }[])[0].id).toBe(
        (byAuditor.body as { id: string }).id,
      );
      const staffList = await call(
        'get',
        `/engagements/${engagement.id}/comments`,
        workerToken,
      ).expect(200);
      expect(staffList.body).toHaveLength(3);
      await call('delete', `/subtasks/${task.id}`).expect(204);
      const afterTaskDelete = await call(
        'get',
        `/engagements/${engagement.id}/comments`,
      ).expect(200);
      expect(afterTaskDelete.body).toHaveLength(2);
      expect((byStaff.body as { id: string }).id).toBeTruthy();
    });

    it('scopes comments to viewable engagements and restricts edits to their author', async () => {
      const hidden = await createEngagement(otherId);
      await call('post', `/engagements/${hidden.id}/comments`, workerToken)
        .send({ text: 'Denied' })
        .expect(403);
      await call(
        'get',
        `/engagements/${hidden.id}/comments`,
        workerToken,
      ).expect(403);
      const hiddenTask = await createSubTask(hidden.id, otherId);
      await call('post', `/subtasks/${hiddenTask.id}/comments`, workerToken)
        .send({ text: 'Denied' })
        .expect(403);
      const engagement = await createEngagement();
      const task = await createSubTask(engagement.id);
      for (const path of [
        `/engagements/${engagement.id}/comments`,
        `/subtasks/${task.id}/comments`,
      ]) {
        const response = await call('post', path, workerToken)
          .send({ text: 'Staff original' })
          .expect(201);
        const staffComment = response.body as { id: string };
        await call('patch', `/comments/${staffComment.id}`)
          .send({ text: 'Auditor rewrite' })
          .expect(403);
        expect(
          await prisma.comment.findUniqueOrThrow({
            where: { id: staffComment.id },
          }),
        ).toMatchObject({ text: 'Staff original', authorId: staffId });
        await call('patch', `/comments/${staffComment.id}`, workerToken)
          .send({ text: 'Author correction' })
          .expect(200);
        expect(
          await prisma.comment.findUniqueOrThrow({
            where: { id: staffComment.id },
          }),
        ).toMatchObject({ text: 'Author correction', authorId: staffId });
      }
      const comment = await call(
        'post',
        `/engagements/${engagement.id}/comments`,
      )
        .send({ text: 'Editable' })
        .expect(201);
      const id = (comment.body as { id: string }).id;
      await call('patch', `/comments/${id}`, workerToken)
        .send({ text: 'Hijack' })
        .expect(403);
      await call('delete', `/comments/${id}`, workerToken).expect(403);
      await request(server())
        .patch(`/comments/${id}`)
        .send({ text: 'Anonymous' })
        .expect(401);
      const updated = await call('patch', `/comments/${id}`)
        .send({ text: 'Revised' })
        .expect(200);
      expect(updated.body).toMatchObject({
        text: 'Revised',
        author: { id: auditorId },
      });
      await call('delete', `/comments/${id}`).expect(204);
      for (const method of ['patch', 'delete'] as const)
        await call(method, `/comments/${id}`)
          .send(method === 'patch' ? { text: 'Gone' } : undefined)
          .expect(404);
      await call('post', `/engagements/${engagement.id}/comments`)
        .send({ text: ' ' })
        .expect(400);
    });
  });

  it('health: reports readiness against PostgreSQL without authentication', async () => {
    await request(server()).get('/health/ready').expect(200);
  });

  it('auth: logs in all roles and returns safe profiles', async () => {
    for (const email of ['auditor', 'staff', 'other']) {
      const response = await request(server())
        .post('/auth/login')
        .send({ email: ` ${email.toUpperCase()}@TEST.EXAMPLE `, password })
        .expect(200);
      const body = response.body as {
        accessToken: string;
        user: { id: string; role: string };
      };
      expect(body.accessToken).toEqual(expect.any(String));
      expect(response.text).not.toContain('passwordHash');
      if (email === 'auditor') auditorToken = body.accessToken;
      if (email === 'staff') staffToken = body.accessToken;
      if (email === 'other') otherToken = body.accessToken;
    }
    const me = await request(server())
      .get('/auth/me')
      .set('Authorization', bearer(staffToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(200);
    expect((me.body as { id: string }).id).toBe(staffId);
  });

  it('auth: rejects invalid credentials, invalid input and untrusted tokens', async () => {
    await request(server())
      .post('/auth/login')
      .send({ email: 'staff@test.example', password: 'incorrect' })
      .expect(401);
    await request(server())
      .post('/auth/login')
      .send({ email: 'missing@test.example', password })
      .expect(401);
    await request(server())
      .post('/auth/login')
      .send({ email: 'invalid', password })
      .expect(400);
    await request(server()).get('/auth/me').expect(401);
    await request(server())
      .get('/auth/me')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    const jwt = new JwtService({ secret: process.env.JWT_SECRET });
    const expired = jwt.sign(
      { sub: staffId },
      {
        expiresIn: -1,
        issuer: 'audit-practice-api',
        audience: 'audit-practice-app',
      },
    );
    await request(server())
      .get('/auth/me')
      .set('Authorization', bearer(expired))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(401);
    const forged = new JwtService({ secret: 'another-secret' }).sign({
      sub: auditorId,
    });
    await request(server())
      .get('/users')
      .set('Authorization', bearer(forged))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(401);
  });

  it('users: auditor creates staff, hashes passwords and rejects duplicates/role injection', async () => {
    const input = {
      name: ' New Staff ',
      email: ' NEW@TEST.EXAMPLE ',
      password,
    };
    const response = await request(server())
      .post('/users')
      .set('Authorization', bearer(auditorToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .send(input)
      .expect(201);
    expect(response.body).toMatchObject({
      name: 'New Staff',
      email: 'new@test.example',
      role: 'STAFF',
    });
    expect(response.text).not.toContain('password');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { email: 'new@test.example' },
    });
    expect(stored.passwordHash).not.toBe(password);
    await request(server())
      .post('/users')
      .set('Authorization', bearer(auditorToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .send(input)
      .expect(409);
    await request(server())
      .post('/users')
      .set('Authorization', bearer(auditorToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .send({ ...input, role: 'AUDITOR' })
      .expect(400);
    const responseList = await request(server())
      .get('/users')
      .set('Authorization', bearer(auditorToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(200);
    expect(
      (responseList.body as { role: string }[]).every(
        (user) => user.role === 'STAFF',
      ),
    ).toBe(true);
    expect(responseList.text).not.toContain('passwordHash');
  });

  it('users: staff cannot list/create users, and current database roles override token claims', async () => {
    await request(server())
      .get('/users')
      .set('Authorization', bearer(staffToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(403);
    await request(server())
      .post('/users')
      .set('Authorization', bearer(staffToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .send({ name: 'No', email: 'no@test.example', password })
      .expect(403);
    await request(server()).get('/users').expect(401);
    const jwt = new JwtService({ secret: process.env.JWT_SECRET });
    const claimedAuditor = jwt.sign(
      { sub: otherId, role: 'AUDITOR' },
      {
        expiresIn: '1h',
        issuer: 'audit-practice-api',
        audience: 'audit-practice-app',
      },
    );
    await request(server())
      .get('/users')
      .set('Authorization', bearer(claimedAuditor))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(403);
    await request(server())
      .get('/auth/me')
      .set('Authorization', bearer(otherToken))
      .set('X-Fiscal-Year-Id', 'fixture')
      .expect(200);
  });
  it('fiscal years: preserves history and enforces ownership across every work API', async () => {
    type FiscalRecord = {
      id: string;
      lineageId: string;
      fiscalYearId: string;
      name: string;
      createdAt: string;
      startDate: string;
      subTasks: unknown[];
      comments: { id: string; text: string }[];
    };
    const json = (response: { body: unknown }) => response.body as FiscalRecord;
    const rows = (response: { body: unknown }) =>
      response.body as FiscalRecord[];
    const call = (
      method: 'get' | 'post' | 'patch' | 'delete',
      path: string,
      year?: string,
      token = auditorToken,
    ) => {
      const req = request(server())
        [method](path)
        .set('Authorization', bearer(token));
      return year ? req.set('X-Fiscal-Year-Id', year) : req;
    };
    await call('get', '/clients').expect(400);
    await call('post', '/fiscal-years', undefined, staffToken)
      .send({ startDate: '2025-07-17', endDate: '2026-07-17' })
      .expect(403);
    await call('post', '/fiscal-years')
      .send({ startDate: '2025-07-16', endDate: '2026-07-16' })
      .expect(400);
    await call('post', '/fiscal-years')
      .send({
        startDate: '2025-07-17',
        endDate: '2026-07-17',
        copyFromId: 'missing-year',
      })
      .expect(404);
    const first = await call('post', '/fiscal-years')
      .send({ startDate: '2025-07-17', endDate: '2026-07-17' })
      .expect(201);
    const y1 = json(first).id;
    const c = await call('post', '/clients', y1)
      .send({
        name: 'Original yearly profile',
        pan: '012345678',
        fileLocation: 'Archive A',
        location: 'Kathmandu',
      })
      .expect(201);
    const e = await call('post', '/engagements', y1)
      .send({
        clientId: json(c).id,
        staffId,
        natureOfWork: 'Prior year return filed later',
        startDate: '2026-09-19',
      })
      .expect(201);
    await call('patch', `/clients/${json(c).id}/ird-credentials`, y1)
      .send({
        userId: '000001',
        password: 'historic-IRD-password',
        registrationNo: '000007',
        nextRenewalDate: '2026-09-19',
      })
      .expect(200);
    const task = await call('post', `/engagements/${json(e).id}/subtasks`, y1)
      .send({ title: 'Historic task', assignedToId: staffId })
      .expect(201);
    const comment = await call(
      'post',
      `/subtasks/${json(task).id}/comments`,
      y1,
    )
      .send({ text: 'Historic evidence' })
      .expect(201);
    const second = await call('post', '/fiscal-years')
      .send({ startDate: '2026-07-17', endDate: '2027-07-17', copyFromId: y1 })
      .expect(201);
    const y2 = json(second).id;
    const copied = await call('get', '/clients', y2).expect(200);
    expect(copied.body).toHaveLength(1);
    expect(rows(copied)[0].id).not.toBe(json(c).id);
    expect(rows(copied)[0].lineageId).toBe(json(c).lineageId);
    expect(rows(copied)[0].fiscalYearId).toBe(y2);
    expect(rows(copied)[0]).toMatchObject({
      pan: '012345678',
      fileLocation: 'Archive A',
      location: 'Kathmandu',
    });
    await call('get', `/clients/${rows(copied)[0].id}/ird-credentials`, y2)
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({
          userId: '000001',
          hasPassword: true,
          registrationNo: '000007',
          nextRenewalDate: '2026-09-19T00:00:00.000Z',
        }),
      );
    const revealChallenge = await call(
      'post',
      `/clients/${rows(copied)[0].id}/ird-credentials/challenge`,
      y2,
    )
      .send({})
      .expect(201);
    const challengeData = revealChallenge.body as {
      token: string;
      question: string;
    };
    await call(
      'post',
      `/clients/${rows(copied)[0].id}/ird-credentials/reveal`,
      y2,
    )
      .send({
        token: challengeData.token,
        answer: challengeData.question
          .split(' + ')
          .map(Number)
          .reduce((a, b) => a + b, 0),
      })
      .expect(201)
      .expect((res) =>
        expect(res.body).toEqual({ password: 'historic-IRD-password' }),
      );
    await call('patch', `/clients/${rows(copied)[0].id}/ird-credentials`, y2)
      .send({ userId: 'changed-in-new-year' })
      .expect(200);
    await call('get', `/clients/${json(c).id}/ird-credentials`, y1)
      .expect(200)
      .expect((res) =>
        expect((res.body as { userId: string }).userId).toBe('000001'),
      );
    await call('get', '/engagements', y2).expect(200).expect([]);
    await call('patch', `/clients/${rows(copied)[0].id}`, y2)
      .send({ name: 'Changed in new year' })
      .expect(200);
    await call('get', `/clients/${json(c).id}`, y1)
      .expect(200)
      .expect((res) => expect(json(res).name).toBe('Original yearly profile'));
    for (const path of [
      `/clients/${json(c).id}`,
      `/engagements/${json(e).id}`,
    ]) {
      await call('get', path, y2).expect(404);
      await call('delete', path, y2).expect(404);
    }
    await call('patch', `/clients/${json(c).id}`, y2)
      .send({ name: 'Wrong year' })
      .expect(404);
    await call('patch', `/engagements/${json(e).id}`, y2)
      .send({ natureOfWork: 'Wrong year' })
      .expect(404);
    await call('post', '/engagements', y2)
      .send({
        clientId: json(c).id,
        staffId,
        natureOfWork: 'Wrong client year',
      })
      .expect(400);
    await call('patch', `/engagements/${json(e).id}`, y1)
      .send({ clientId: rows(copied)[0].id })
      .expect(400);
    await call('get', `/engagements/${json(e).id}/subtasks`, y2)
      .expect(200)
      .expect([]);
    await call('post', `/engagements/${json(e).id}/subtasks`, y2)
      .send({ title: 'Wrong year', assignedToId: staffId })
      .expect(404);
    await call('patch', `/subtasks/${json(task).id}`, y2, staffToken)
      .send({ status: 'DONE' })
      .expect(404);
    await call('delete', `/subtasks/${json(task).id}`, y2).expect(404);
    await call('post', `/subtasks/${json(task).id}/comments`, y2)
      .send({ text: 'Wrong year' })
      .expect(404);
    await call('post', `/engagements/${json(e).id}/comments`, y2)
      .send({ text: 'Wrong year' })
      .expect(403);
    await call('patch', `/comments/${json(comment).id}`, y2)
      .send({ text: 'Wrong year' })
      .expect(404);
    await call('delete', `/comments/${json(comment).id}`, y2).expect(404);
    const historic = await call('get', `/engagements/${json(e).id}`, y1).expect(
      200,
    );
    expect(json(historic).subTasks).toHaveLength(7);
    expect(json(historic).comments[0].text).toBe('Historic evidence');
    expect(json(historic).startDate).toBe('2026-09-19T00:00:00.000Z');
    await call('post', '/fiscal-years')
      .send({ startDate: '2026-07-17', endDate: '2027-07-17' })
      .expect(409);
    await call('post', '/clients', 'legacy')
      .send({
        name: 'No new legacy data',
        pan: '123456789',
        fileLocation: 'Test shelf',
      })
      .expect(400);
    const legacyClient = await prisma.client.create({
      data: {
        name: 'Reviewed client',
        pan: '987654321',
        fileLocation: 'Legacy shelf',
        location: 'Lalitpur',
      },
    });
    const legacy = {
      body: await prisma.engagement.create({
        data: {
          clientId: legacyClient.id,
          staffId,
          natureOfWork: 'Reviewed legacy audit',
        },
      }),
    };
    const legacyComment = await call(
      'post',
      `/engagements/${json(legacy).id}/comments`,
      'legacy',
    )
      .send({ text: 'Preserve original note' })
      .expect(201);
    await call('post', `/fiscal-years/${y1}/assign-legacy`)
      .send({ engagementId: json(legacy).id })
      .expect(201);
    await call('post', `/fiscal-years/${y2}/assign-legacy`)
      .send({ engagementId: json(legacy).id })
      .expect(404);
    const assigned = await call(
      'get',
      `/engagements/${json(legacy).id}`,
      y1,
    ).expect(200);
    expect(json(assigned).createdAt).toBe(legacy.body.createdAt.toISOString());
    expect(json(assigned).comments[0].id).toBe(json(legacyComment).id);
    expect(
      await prisma.client.findUniqueOrThrow({
        where: {
          fiscalYearId_lineageId: {
            fiscalYearId: y1,
            lineageId: legacyClient.lineageId,
          },
        },
      }),
    ).toMatchObject({
      pan: '987654321',
      fileLocation: 'Legacy shelf',
      location: 'Lalitpur',
    });
    await call('get', `/engagements/${json(legacy).id}`, 'legacy').expect(404);
  });
});
