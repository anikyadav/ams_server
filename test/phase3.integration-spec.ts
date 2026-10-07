import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

process.env.IRD_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
jest.setTimeout(120000);

type Task = {
  id: string;
  title: string;
  templateKey: string | null;
  status: string;
  progress: number;
  reviewState: string;
  reviewNote: string | null;
  blockedReason: string | null;
  blockedAt: string | null;
  dueDate: string | null;
  submittedBy: { id: string } | null;
  reviewedBy: { id: string } | null;
  checklist: { id: string; text: string; done: boolean }[];
};
type EngagementBody = {
  id: string;
  status: string;
  subTasks: Task[];
  documentRequests: { id: string; title: string; status: string }[];
  startDate: string | null;
  targetDate: string | null;
};

describe('Phase 3: sign-off, blocked flag, checklist, requests, mentions, cloning', () => {
  const schema = `test_api_${randomUUID().replaceAll('-', '')}`;
  const password = 'Test-password-12345';
  let app: INestApplication<App>;
  let db: Client;
  let prisma: PrismaService;
  let staffId: string;
  let otherId: string;
  let auditorId: string;
  const tokens: Record<string, string> = {};
  const lineageId = 'lineage-phase3';
  const server = () => app.getHttpServer();

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    who: 'auditor' | 'staff' | 'other',
    year = 'fixture',
  ) =>
    request(server())
      [method](path)
      .set('Authorization', `Bearer ${tokens[who]}`)
      .set('X-Fiscal-Year-Id', year);

  async function newEngagement(natureOfWork: string) {
    const clients = await prisma.client.findFirstOrThrow({
      where: { fiscalYearId: 'fixture' },
    });
    const response = await call('post', '/engagements', 'auditor')
      .send({ clientId: clients.id, staffId, natureOfWork })
      .expect(201);
    return response.body as EngagementBody;
  }
  const taskOf = (engagement: EngagementBody, key: string) =>
    engagement.subTasks.find((task) => task.templateKey === key)!;
  const fetchEngagement = async (
    id: string,
    who: 'auditor' | 'staff' = 'auditor',
  ) =>
    (await call('get', `/engagements/${id}`, who).expect(200))
      .body as EngagementBody;

  beforeAll(async () => {
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
      .filter((entry) => /^\d/.test(entry))
      .sort()) {
      const sql = readFileSync(
        resolve(migrations, name, 'migration.sql'),
        'utf8',
      );
      await db.query(sql.replaceAll('"public"', `"${schema}"`));
    }
    await db.query('COMMIT');
    const url = new URL(process.env.DATABASE_URL!);
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
    await prisma.fiscalYear.create({
      data: {
        id: 'next',
        startDate: new Date('2024-07-16'),
        endDate: new Date('2025-07-16'),
      },
    });
    const passwordHash = await hash(password, 12);
    const user = (name: string, email: string, role: 'AUDITOR' | 'STAFF') =>
      prisma.user.create({ data: { name, email, passwordHash, role } });
    auditorId = (await user('Auditor', 'auditor@test.example', 'AUDITOR')).id;
    staffId = (await user('Staff', 'staff@test.example', 'STAFF')).id;
    otherId = (await user('Other', 'other@test.example', 'STAFF')).id;
    const clientData = {
      name: 'Carry Client',
      pan: '012345678',
      fileLocation: 'Cabinet A',
      lineageId,
    };
    await prisma.client.create({
      data: { ...clientData, fiscalYearId: 'fixture' },
    });
    for (const who of ['auditor', 'staff', 'other']) {
      const response = await request(server())
        .post('/auth/login')
        .send({ email: `${who}@test.example`, password })
        .expect(200);
      tokens[who] = (response.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    else if (prisma) await prisma.$disconnect();
    if (db) {
      if (!/^test_api_[a-f0-9]{32}$/.test(schema))
        throw new Error('Invalid cleanup schema');
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.end();
    }
  });

  it('staff completion is submitted for review; the auditor approves or sends it back; completion needs sign-off', async () => {
    const engagement = await newEngagement('Sign-off audit');
    const doc = taskOf(engagement, 'DOCUMENT');
    expect(doc.reviewState).toBe('NOT_SUBMITTED');

    const submitted = await call('patch', `/subtasks/${doc.id}`, 'staff')
      .send({ status: 'DONE' })
      .expect(200);
    expect(submitted.body).toMatchObject({
      status: 'DONE',
      reviewState: 'SUBMITTED',
      submittedBy: { id: staffId },
      reviewedBy: null,
    });
    const inbox = await call('get', '/notifications', 'auditor').expect(200);
    expect(
      (inbox.body as { items: { type: string }[] }).items.map(
        (item) => item.type,
      ),
    ).toContain('TASK_SUBMITTED');

    // An engagement cannot be completed until every compulsory task is approved.
    const blocked = await call(
      'patch',
      `/engagements/${engagement.id}`,
      'auditor',
    )
      .send({ status: 'COMPLETE' })
      .expect(400);
    expect(JSON.stringify(blocked.body)).toContain(
      'Compulsory tasks need auditor approval',
    );
    await call('patch', `/engagements/${engagement.id}/progress`, 'staff')
      .send({ progress: 100 })
      .expect(400);

    await call('post', `/subtasks/${doc.id}/review`, 'staff')
      .send({ decision: 'APPROVE' })
      .expect(403);
    await call('post', `/subtasks/${doc.id}/review`, 'auditor')
      .send({ decision: 'REQUEST_CHANGES' })
      .expect(400);
    const sentBack = await call('post', `/subtasks/${doc.id}/review`, 'auditor')
      .send({ decision: 'REQUEST_CHANGES', note: 'Attach the signed copy' })
      .expect(201);
    expect(sentBack.body).toMatchObject({
      status: 'IN_PROGRESS',
      progress: 75,
      reviewState: 'CHANGES_REQUESTED',
      reviewNote: 'Attach the signed copy',
      reviewedBy: { id: auditorId },
    });
    const withComment = await fetchEngagement(engagement.id);
    expect(
      (
        withComment as unknown as { comments: { text: string }[] }
      ).comments.some((comment) =>
        comment.text.includes('Attach the signed copy'),
      ),
    ).toBe(true);
    await call('post', `/subtasks/${doc.id}/review`, 'auditor')
      .send({ decision: 'APPROVE' })
      .expect(400);

    const resubmitted = await call('patch', `/subtasks/${doc.id}`, 'staff')
      .send({ status: 'DONE' })
      .expect(200);
    expect(resubmitted.body).toMatchObject({
      reviewState: 'SUBMITTED',
      reviewNote: null,
    });
    const approved = await call('post', `/subtasks/${doc.id}/review`, 'auditor')
      .send({ decision: 'APPROVE' })
      .expect(201);
    expect(approved.body).toMatchObject({
      reviewState: 'APPROVED',
      reviewedBy: { id: auditorId },
    });
    const trail = await call(
      'get',
      `/subtasks/${doc.id}/activity`,
      'auditor',
    ).expect(200);
    expect(
      (trail.body as { action: string }[]).map((entry) => entry.action),
    ).toEqual(
      expect.arrayContaining([
        'SUBTASK_APPROVED',
        'SUBTASK_CHANGES_REQUESTED',
        'SUBTASK_COMPLETED',
      ]),
    );

    // The auditor completing a task is the reviewer, so it is approved at once.
    for (const task of engagement.subTasks.filter(
      (item) => item.id !== doc.id,
    )) {
      const done = await call('patch', `/subtasks/${task.id}`, 'auditor')
        .send({ status: 'DONE' })
        .expect(200);
      expect(done.body).toMatchObject({ reviewState: 'APPROVED' });
    }
    await call('patch', `/engagements/${engagement.id}`, 'auditor')
      .send({ status: 'COMPLETE' })
      .expect(200);

    // Reopening work clears its sign-off.
    const reopened = await call('patch', `/subtasks/${doc.id}`, 'auditor')
      .send({ status: 'TODO' })
      .expect(200);
    expect(reopened.body).toMatchObject({
      reviewState: 'NOT_SUBMITTED',
      reviewedBy: null,
    });
  });

  it('lets assignees flag a blocker, notifies the team and clears it on completion', async () => {
    const engagement = await newEngagement('Blocked audit');
    const task = taskOf(engagement, 'VAT_RECO');
    const blocked = await call('patch', `/subtasks/${task.id}`, 'staff')
      .send({ blockedReason: 'Waiting for the bank letter' })
      .expect(200);
    expect(blocked.body).toMatchObject({
      blockedReason: 'Waiting for the bank letter',
    });
    expect((blocked.body as Task).blockedAt).toEqual(expect.any(String));
    await call('patch', `/subtasks/${task.id}`, 'staff')
      .send({ title: 'Renamed' })
      .expect(403);
    await call('patch', `/subtasks/${task.id}`, 'other')
      .send({ blockedReason: 'Not mine' })
      .expect(404);
    const inbox = await call('get', '/notifications', 'auditor').expect(200);
    expect(
      (inbox.body as { items: { type: string; message: string }[] }).items.some(
        (item) =>
          item.type === 'TASK_BLOCKED' && item.message.includes('bank letter'),
      ),
    ).toBe(true);
    const cleared = await call('patch', `/subtasks/${task.id}`, 'staff')
      .send({ blockedReason: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      blockedReason: null,
      blockedAt: null,
    });
    await call('patch', `/subtasks/${task.id}`, 'staff')
      .send({ blockedReason: 'Again' })
      .expect(200);
    const done = await call('patch', `/subtasks/${task.id}`, 'staff')
      .send({ status: 'DONE' })
      .expect(200);
    expect(done.body).toMatchObject({
      blockedReason: null,
      reviewState: 'SUBMITTED',
    });
  });

  it('derives task progress from checklist steps and enforces who may edit them', async () => {
    const engagement = await newEngagement('Checklist audit');
    const task = taskOf(engagement, 'SALES_RECO');
    let current: Task = task;
    for (const text of [
      'Request ledger',
      'Tick sample',
      'Summarise',
      'Sign off',
    ]) {
      const added = await call(
        'post',
        `/subtasks/${task.id}/checklist`,
        'auditor',
      )
        .send({ text })
        .expect(201);
      current = added.body as Task;
    }
    expect(current.checklist.map((item) => item.text)).toEqual([
      'Request ledger',
      'Tick sample',
      'Summarise',
      'Sign off',
    ]);
    expect(current.progress).toBe(0);
    await call('post', `/subtasks/${task.id}/checklist`, 'staff')
      .send({ text: 'Staff step' })
      .expect(403);
    const [first, second, third, fourth] = current.checklist;

    await call('patch', `/checklist-items/${first.id}`, 'other')
      .send({ done: true })
      .expect(404);
    await call('patch', `/checklist-items/${first.id}`, 'staff')
      .send({ text: 'Renamed' })
      .expect(403);
    const one = await call('patch', `/checklist-items/${first.id}`, 'staff')
      .send({ done: true })
      .expect(200);
    expect(one.body).toMatchObject({ progress: 25, status: 'IN_PROGRESS' });
    for (const item of [second, third]) {
      await call('patch', `/checklist-items/${item.id}`, 'staff')
        .send({ done: true })
        .expect(200);
    }
    const last = await call('patch', `/checklist-items/${fourth.id}`, 'staff')
      .send({ done: true })
      .expect(200);
    expect(last.body).toMatchObject({
      progress: 100,
      status: 'DONE',
      reviewState: 'SUBMITTED',
    });
    const undone = await call('patch', `/checklist-items/${fourth.id}`, 'staff')
      .send({ done: false })
      .expect(200);
    expect(undone.body).toMatchObject({
      progress: 75,
      status: 'IN_PROGRESS',
      reviewState: 'NOT_SUBMITTED',
    });
    await call('delete', `/checklist-items/${fourth.id}`, 'staff').expect(403);
    const removed = await call(
      'delete',
      `/checklist-items/${fourth.id}`,
      'auditor',
    ).expect(200);
    expect(removed.body).toMatchObject({ progress: 100, status: 'DONE' });
    expect((removed.body as Task).checklist).toHaveLength(3);
    const detail = await fetchEngagement(engagement.id);
    expect(taskOf(detail, 'SALES_RECO').checklist).toHaveLength(3);
  });

  it('tracks client document requests and who may change them', async () => {
    const engagement = await newEngagement('Requests audit');
    const created = await call(
      'post',
      `/engagements/${engagement.id}/requests`,
      'auditor',
    )
      .send({ title: 'Bank statements', dueDate: '2024-01-15' })
      .expect(201);
    const requestId = (created.body as { id: string }).id;
    await call('post', `/engagements/${engagement.id}/requests`, 'staff')
      .send({ title: 'Not allowed' })
      .expect(403);
    const list = await call(
      'get',
      `/engagements/${engagement.id}/requests`,
      'staff',
    ).expect(200);
    expect(list.body).toHaveLength(1);
    await call('get', `/engagements/${engagement.id}/requests`, 'other').expect(
      404,
    );
    await call('patch', `/document-requests/${requestId}`, 'staff')
      .send({ title: 'Renamed' })
      .expect(403);
    await call('patch', `/document-requests/${requestId}`, 'other')
      .send({ status: 'RECEIVED' })
      .expect(404);
    const received = await call(
      'patch',
      `/document-requests/${requestId}`,
      'staff',
    )
      .send({ status: 'RECEIVED', reference: 'Cabinet A / Folder 3' })
      .expect(200);
    expect(received.body).toMatchObject({
      status: 'RECEIVED',
      reference: 'Cabinet A / Folder 3',
      receivedBy: { id: staffId },
    });
    expect((received.body as { receivedAt: string }).receivedAt).toEqual(
      expect.any(String),
    );
    const detail = await fetchEngagement(engagement.id, 'staff');
    expect(detail.documentRequests).toHaveLength(1);
    const reopened = await call(
      'patch',
      `/document-requests/${requestId}`,
      'auditor',
    )
      .send({ status: 'REQUESTED' })
      .expect(200);
    expect(reopened.body).toMatchObject({
      status: 'REQUESTED',
      receivedBy: null,
    });
    await call('delete', `/document-requests/${requestId}`, 'staff').expect(
      403,
    );
    await call('delete', `/document-requests/${requestId}`, 'auditor').expect(
      204,
    );
    await call('delete', `/document-requests/${requestId}`, 'auditor').expect(
      404,
    );
  });

  it('notifies @mentioned people once and lists who can be mentioned', async () => {
    const engagement = await newEngagement('Mentions audit');
    const people = await call(
      'get',
      `/engagements/${engagement.id}/participants`,
      'staff',
    ).expect(200);
    expect(
      (people.body as { name: string }[]).map((person) => person.name),
    ).toEqual(['Auditor', 'Staff']);
    await call('post', `/engagements/${engagement.id}/comments`, 'auditor')
      .send({ text: 'Please review this, @Staff. Thanks @Other' })
      .expect(201);
    const inbox = await call('get', '/notifications', 'staff').expect(200);
    const items = (
      inbox.body as { items: { type: string; message: string }[] }
    ).items.filter((item) => item.message.includes('Please review this'));
    expect(items.map((item) => item.type)).toEqual(['MENTION']);
    // "Other" cannot see this engagement, so a mention does not reach them.
    const others = await call('get', '/notifications', 'other').expect(200);
    expect(
      (others.body as { items: { message: string }[] }).items.some((item) =>
        item.message.includes('Please review this'),
      ),
    ).toBe(false);
  });

  it('copies an engagement into the next fiscal year with dates shifted and work reset', async () => {
    const source = await newEngagement('Annual audit');
    await prisma.engagement.update({
      where: { id: source.id },
      data: {
        startDate: new Date('2023-08-01'),
        targetDate: new Date('2024-01-01'),
      },
    });
    const doc = taskOf(source, 'DOCUMENT');
    await call('patch', `/subtasks/${doc.id}`, 'auditor')
      .send({ dueDate: '2023-12-01', status: 'DONE' })
      .expect(200);
    await call('post', `/subtasks/${doc.id}/checklist`, 'auditor')
      .send({ text: 'Collect registration' })
      .expect(201);
    await call('post', `/engagements/${source.id}/subtasks`, 'auditor')
      .send({ title: 'Extra review', assignedToId: otherId, priority: 'HIGH' })
      .expect(201);
    await call('post', `/engagements/${source.id}/requests`, 'auditor')
      .send({ title: 'Trial balance', dueDate: '2023-10-10' })
      .expect(201);

    // The client is not in the next year yet, so the copy is skipped with a reason.
    const early = await call('post', '/engagements/clone', 'auditor', 'next')
      .send({ sourceIds: [source.id] })
      .expect(201);
    expect(early.body).toMatchObject({
      created: [],
      skipped: [{ reason: 'The client was not carried into this fiscal year' }],
    });

    await prisma.client.create({
      data: {
        name: 'Carry Client',
        pan: '012345678',
        fileLocation: 'Cabinet A',
        lineageId,
        fiscalYearId: 'next',
      },
    });
    await call('post', '/engagements/clone', 'staff', 'next')
      .send({ sourceIds: [source.id] })
      .expect(403);
    const copied = await call('post', '/engagements/clone', 'auditor', 'next')
      .send({ sourceIds: [source.id, source.id, 'missing-id'] })
      .expect(201);
    const result = copied.body as {
      created: { id: string }[];
      skipped: { reason: string }[];
    };
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: 'Not found' }),
    ]);

    const clone = (
      await call(
        'get',
        `/engagements/${result.created[0].id}`,
        'auditor',
        'next',
      ).expect(200)
    ).body as EngagementBody;
    const gap = 365; // 2023-07-17 → 2024-07-16 (leap year)
    const shifted = (iso: string) =>
      new Date(Date.parse(iso) + gap * 86_400_000).toISOString().slice(0, 10);
    expect(clone.status).toBe('NOT_STARTED');
    expect(clone.startDate?.slice(0, 10)).toBe(shifted('2023-08-01'));
    expect(clone.targetDate?.slice(0, 10)).toBe(shifted('2024-01-01'));
    expect(clone.subTasks).toHaveLength(7);
    const clonedDoc = taskOf(clone, 'DOCUMENT');
    expect(clonedDoc).toMatchObject({
      status: 'TODO',
      progress: 0,
      reviewState: 'NOT_SUBMITTED',
    });
    expect(clonedDoc.dueDate?.slice(0, 10)).toBe(shifted('2023-12-01'));
    expect(clonedDoc.checklist.map((item) => [item.text, item.done])).toEqual([
      ['Collect registration', false],
    ]);
    expect(
      clone.subTasks.find((task) => task.title === 'Extra review'),
    ).toBeDefined();
    expect(clone.documentRequests).toEqual([
      expect.objectContaining({ title: 'Trial balance', status: 'REQUESTED' }),
    ]);

    const again = await call('post', '/engagements/clone', 'auditor', 'next')
      .send({ sourceIds: [source.id] })
      .expect(201);
    expect(again.body).toMatchObject({
      created: [],
      skipped: [{ reason: 'Already exists in this fiscal year' }],
    });
    const same = await call('post', '/engagements/clone', 'auditor')
      .send({ sourceIds: [source.id] })
      .expect(201);
    expect(same.body).toMatchObject({
      skipped: [{ reason: 'Already belongs to this fiscal year' }],
    });
  });

  it('marks work finished before sign-off existed as approved in the migration', async () => {
    const engagement = await newEngagement('Legacy audit');
    const task = taskOf(engagement, 'PURCHASE_RECO');
    // Simulate a pre-migration completed task, then re-run the data statement.
    await prisma.subTask.update({
      where: { id: task.id },
      data: {
        status: 'DONE',
        progress: 100,
        completedAt: new Date(),
        reviewState: 'NOT_SUBMITTED',
      },
    });
    const sql = readFileSync(
      resolve(
        __dirname,
        '../prisma/migrations/20261010000000_review_checklist_requests/migration.sql',
      ),
      'utf8',
    );
    const update = sql.match(/UPDATE "SubTask"[\s\S]*?;/)![0];
    await db.query(`SET search_path TO "${schema}"`);
    await db.query(update.replaceAll('"public"', `"${schema}"`));
    const row = await prisma.subTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.reviewState).toBe('APPROVED');
  });
});
