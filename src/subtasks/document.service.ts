import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import { IrdCredentialsService } from '../clients/ird-credentials.service';
import type { CurrentUser } from '../auth/access';
import type { UpdateDocumentDto, RevealDocumentDto } from './document.dto';

@Injectable()
export class DocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
    private readonly credentials: IrdCredentialsService,
  ) {}
  private async authorize(id: string, actor: CurrentUser) {
    const task = await this.prisma.subTask.findFirst({
      where: {
        id,
        templateKey: 'DOCUMENT',
        engagement: { fiscalYearId: this.fiscal.id },
        ...(actor.role === 'AUDITOR' ? {} : { assignedToId: actor.id }),
      },
      include: { engagement: { select: { clientId: true } } },
    });
    if (!task) throw new NotFoundException('Assigned Document task not found');
    return task;
  }
  async read(id: string, actor: CurrentUser) {
    const task = await this.authorize(id, actor);
    return this.credentials.read(task.engagement.clientId, actor);
  }
  async update(id: string, input: UpdateDocumentDto, actor: CurrentUser) {
    const task = await this.authorize(id, actor);
    return this.credentials.update(task.engagement.clientId, input, actor);
  }
  async challenge(id: string, actor: CurrentUser) {
    const task = await this.authorize(id, actor);
    return this.credentials.challenge(task.engagement.clientId, actor);
  }
  async reveal(id: string, input: RevealDocumentDto, actor: CurrentUser) {
    const task = await this.authorize(id, actor);
    const result = await this.credentials.reveal(
      task.engagement.clientId,
      input,
      actor,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.activityLog.create({
        data: {
          engagementId: task.engagementId,
          subTaskId: id,
          actorId: actor.id,
          action: 'DOCUMENT_PASSWORD_REVEALED',
          summary:
            'Revealed 1.3 IRD password after completing the calculation.',
        },
      });
    });
    return result;
  }
}
