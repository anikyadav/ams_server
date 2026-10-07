import 'dotenv/config';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

jest.setTimeout(60000);

describe('Six compulsory tasks upgrade (isolated schema)', () => {
  const schema = `test_required_${randomUUID().replaceAll('-', '')}`;
  const migrations = resolve(__dirname, '../prisma/migrations');
  const upgrade = '20261007010000_six_required_tasks';
  let db: Client;

  beforeAll(async () => {
    db = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
    });
    await db.connect();
    await db.query('BEGIN');
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    for (const name of readdirSync(migrations)
      .filter((name) => /^\d/.test(name) && name !== upgrade)
      .sort()) {
      await db.query(
        readFileSync(
          resolve(migrations, name, 'migration.sql'),
          'utf8',
        ).replaceAll('"public"', `"${schema}"`),
      );
    }
    await db.query(
      `INSERT INTO "User" ("id","name","email","passwordHash","role") VALUES ('migration_staff','Staff','migration@test.example','unused-test-hash','STAFF')`,
    );
    await db.query(
      `INSERT INTO "Client" ("id","lineageId","name","pan","fileLocation","fiscalYearId") VALUES ('migration_client','migration_lineage','Client','012345678','Test','legacy')`,
    );
    await db.query(
      `INSERT INTO "Engagement" ("id","clientId","staffId","natureOfWork","fiscalYearId") VALUES ('migration_job','migration_client','migration_staff','Audit','legacy')`,
    );
    await db.query(`INSERT INTO "SubTask" ("id","engagementId","title","templateKey","assignedToId","description","progress","status") VALUES
      ('old-document','migration_job','Document',NULL,'migration_staff','Existing document work',25,'IN_PROGRESS'),
      ('old-vat-a','migration_job','Vat Reco','VAT_RECO','migration_staff',NULL,0,'TODO'),
      ('old-vat-b','migration_job','Vat Reco','VAT_RECO','migration_staff','Duplicate task with history',25,'IN_PROGRESS'),
      ('other-blank','migration_job','Any other','OTHER','migration_staff',NULL,0,'TODO'),
      ('other-worked','migration_job','Any other','OTHER','migration_staff','Extra work already recorded',25,'IN_PROGRESS')`);
    await db.query(
      `INSERT INTO "Comment" ("id","engagementId","subTaskId","authorId","text") VALUES ('migration-comment','migration_job','other-worked','migration_staff','Retain this work')`,
    );
    await db.query(
      readFileSync(resolve(migrations, upgrade, 'migration.sql'), 'utf8'),
    );
  });

  afterAll(async () => {
    if (!/^test_required_[a-f0-9]{32}$/.test(schema))
      throw new Error('Invalid test cleanup schema');
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  it('adds six required identities, adopts existing Document work, and preserves worked additional tasks', async () => {
    const result = await db.query<{
      id: string;
      templateKey: string | null;
      description: string | null;
    }>(
      `SELECT "id","templateKey","description" FROM "SubTask" WHERE "engagementId"='migration_job'`,
    );
    expect(result.rows.filter((row) => row.templateKey !== null)).toHaveLength(
      6,
    );
    expect(result.rows).toContainEqual({
      id: 'old-document',
      templateKey: 'DOCUMENT',
      description: 'Existing document work',
    });
    expect(result.rows.some((row) => row.id === 'other-blank')).toBe(false);
    expect(result.rows).toContainEqual({
      id: 'other-worked',
      templateKey: null,
      description: 'Extra work already recorded',
    });
    expect(result.rows).toContainEqual({
      id: 'old-vat-b',
      templateKey: null,
      description: 'Duplicate task with history',
    });
    expect(
      (
        await db.query(
          `SELECT "text" FROM "Comment" WHERE "id"='migration-comment'`,
        )
      ).rows,
    ).toEqual([{ text: 'Retain this work' }]);
  });

  it('rejects a duplicate compulsory identity but allows any number of additional tasks', async () => {
    await db.query('SAVEPOINT duplicate_check');
    await expect(
      db.query(
        `INSERT INTO "SubTask" ("id","engagementId","title","templateKey","assignedToId") VALUES ('duplicate','migration_job','Document','DOCUMENT','migration_staff')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await db.query('ROLLBACK TO SAVEPOINT duplicate_check');
    await db.query(
      `INSERT INTO "SubTask" ("id","engagementId","title","assignedToId") VALUES ('extra-a','migration_job','Additional A','migration_staff'), ('extra-b','migration_job','Additional B','migration_staff')`,
    );
    expect(
      (
        await db.query(
          `SELECT COUNT(*)::int AS count FROM "SubTask" WHERE "templateKey" IS NOT NULL`,
        )
      ).rows,
    ).toEqual([{ count: 6 }]);
  });
});
