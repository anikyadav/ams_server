import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { Workbook } from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import type { CurrentUser } from '../auth/access';
import type {
  RevealDocumentDto,
  UpdateDocumentDto,
} from '../subtasks/document.dto';
import { encryptDocument, decryptDocument } from '../subtasks/document-crypto';

@Injectable()
export class IrdCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
    private readonly config: ConfigService,
  ) {}
  private key() {
    const value = this.config.get<string>('IRD_CREDENTIAL_ENCRYPTION_KEY');
    if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
      throw new ServiceUnavailableException(
        'IRD credential encryption is not configured',
      );
    return Buffer.from(value, 'hex');
  }
  private assertAuditor(actor: CurrentUser) {
    if (actor.role !== 'AUDITOR')
      throw new ForbiddenException('Only auditors can export IRD credentials');
  }
  private async authorize(clientId: string, actor: CurrentUser) {
    const client = await this.prisma.client.findFirst({
      where: {
        id: clientId,
        fiscalYearId: this.fiscal.id,
        ...(actor.role === 'AUDITOR'
          ? {}
          : {
              engagements: {
                some: {
                  subTasks: {
                    some: { templateKey: 'DOCUMENT', assignedToId: actor.id },
                  },
                },
              },
            }),
      },
    });
    if (!client)
      throw new NotFoundException('Assigned client IRD details not found');
  }
  async read(clientId: string, actor: CurrentUser) {
    await this.authorize(clientId, actor);
    const doc = await this.prisma.clientIrdCredential.findUnique({
      where: { clientId },
    });
    return {
      registrationNo: doc?.registrationNo ?? null,
      userId: doc?.userId ?? null,
      nextRenewalDate: doc?.nextRenewalDate ?? null,
      hasPassword: !!doc?.passwordEncrypted,
    };
  }
  async update(clientId: string, input: UpdateDocumentDto, actor: CurrentUser) {
    await this.authorize(clientId, actor);
    const data = {
      registrationNo: input.registrationNo,
      userId: input.userId,
      nextRenewalDate:
        input.nextRenewalDate === undefined
          ? undefined
          : input.nextRenewalDate
            ? new Date(input.nextRenewalDate)
            : null,
      passwordEncrypted:
        input.password === undefined
          ? undefined
          : input.password === null
            ? null
            : encryptDocument(
                input.password,
                this.key(),
                `ird-password:${clientId}`,
              ),
    };
    await this.prisma.$transaction(
      async (tx) => {
        const previous = await tx.clientIrdCredential.findUnique({
          where: { clientId },
        });
        const fields: string[] = [];
        if (
          input.registrationNo !== undefined &&
          input.registrationNo !== (previous?.registrationNo ?? null)
        )
          fields.push('1.1 Registration No.');
        if (
          input.userId !== undefined &&
          input.userId !== (previous?.userId ?? null)
        )
          fields.push('1.2 IRD user ID');
        if (input.password !== undefined)
          fields.push(
            input.password === null
              ? '1.3 IRD password removed'
              : '1.3 IRD password saved/replaced',
          );
        if (
          input.nextRenewalDate !== undefined &&
          input.nextRenewalDate !==
            (previous?.nextRenewalDate?.toISOString().slice(0, 10) ?? null)
        )
          fields.push('1.4 Next renewal date');
        await tx.clientIrdCredential.upsert({
          where: { clientId },
          create: { clientId, ...data },
          update: data,
        });
        await tx.irdCredentialAccessLog.create({
          data: {
            actorId: actor.id,
            fiscalYearId: this.fiscal.id,
            clientId,
            action: 'IRD_DETAILS_UPDATED',
          },
        });
        if (fields.length) {
          const tasks = await tx.subTask.findMany({
            where: {
              templateKey: 'DOCUMENT',
              engagement: { clientId, fiscalYearId: this.fiscal.id },
            },
            select: { id: true, engagementId: true },
          });
          if (tasks.length)
            await tx.activityLog.createMany({
              data: tasks.map((task) => ({
                engagementId: task.engagementId,
                subTaskId: task.id,
                actorId: actor.id,
                action: 'DOCUMENT_UPDATED',
                summary: `Updated Document fields: ${fields.join('; ')}.`,
              })),
            });
        }
      },
      { timeout: 15_000 },
    );
    return this.read(clientId, actor);
  }
  private makeChallenge(actor: CurrentUser, purpose: string) {
    const left = randomInt(1, 10),
      right = randomInt(1, 10);
    const expiresAt = Date.now() + 120_000;
    const token = encryptDocument(
      JSON.stringify({ answer: left + right, expiresAt }),
      this.key(),
      `ird-challenge:${purpose}:${actor.id}:${this.fiscal.id}`,
    );
    return { token, question: `${left} + ${right}`, expiresAt };
  }
  private verifyChallenge(
    input: RevealDocumentDto,
    actor: CurrentUser,
    purpose: string,
  ) {
    const key = this.key();
    try {
      const challenge = JSON.parse(
        decryptDocument(
          input.token,
          key,
          `ird-challenge:${purpose}:${actor.id}:${this.fiscal.id}`,
        ),
      ) as { answer: number; expiresAt: number };
      if (
        challenge.expiresAt <= Date.now() ||
        challenge.answer !== input.answer
      )
        throw new Error('Invalid answer');
    } catch {
      throw new BadRequestException(
        'Incorrect answer or expired challenge. Try a new calculation.',
      );
    }
  }
  async challenge(clientId: string, actor: CurrentUser) {
    await this.authorize(clientId, actor);
    return this.makeChallenge(actor, `reveal:${clientId}`);
  }
  async reveal(clientId: string, input: RevealDocumentDto, actor: CurrentUser) {
    await this.authorize(clientId, actor);
    this.verifyChallenge(input, actor, `reveal:${clientId}`);
    const doc = await this.prisma.clientIrdCredential.findUnique({
      where: { clientId },
    });
    if (!doc?.passwordEncrypted)
      throw new NotFoundException('No IRD password saved');
    const password = decryptDocument(
      doc.passwordEncrypted,
      this.key(),
      `ird-password:${clientId}`,
    );
    await this.prisma.irdCredentialAccessLog.create({
      data: {
        actorId: actor.id,
        fiscalYearId: this.fiscal.id,
        clientId,
        action: 'IRD_PASSWORD_REVEALED',
      },
    });
    return { password };
  }
  exportChallenge(actor: CurrentUser) {
    this.assertAuditor(actor);
    return this.makeChallenge(actor, 'export');
  }
  async export(input: RevealDocumentDto, actor: CurrentUser) {
    this.assertAuditor(actor);
    this.verifyChallenge(input, actor, 'export');
    const clients = await this.prisma.client.findMany({
      where: { fiscalYearId: this.fiscal.id },
      include: { irdCredential: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('IRD credentials');
    sheet.columns = [
      { header: 'Client name', key: 'name', width: 42 },
      { header: 'IRD user ID', key: 'userId', width: 28 },
      { header: 'IRD password', key: 'password', width: 32 },
    ];
    for (const client of clients) {
      const credential = client.irdCredential;
      // String cells preserve leading zeroes and formula-like passwords verbatim.
      sheet.addRow({
        name: client.name,
        userId: credential?.userId ?? '',
        password: credential?.passwordEncrypted
          ? decryptDocument(
              credential.passwordEncrypted,
              this.key(),
              `ird-password:${client.id}`,
            )
          : '',
      });
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = `A1:C${Math.max(1, clients.length + 1)}`;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await this.prisma.irdCredentialAccessLog.create({
      data: {
        actorId: actor.id,
        fiscalYearId: this.fiscal.id,
        action: 'IRD_CREDENTIALS_EXPORTED',
      },
    });
    return buffer;
  }
}
