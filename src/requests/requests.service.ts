import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  engagementVisibilityWhere,
  safeUserSelect,
  type CurrentUser,
} from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateDocumentRequestDto,
  UpdateDocumentRequestDto,
} from './requests.dto';

const relations = {
  receivedBy: { select: safeUserSelect },
} satisfies Prisma.DocumentRequestInclude;

/** A checklist of what the client still owes the firm, per engagement. */
@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  private async viewable(engagementId: string, actor: CurrentUser) {
    const engagement = await this.prisma.engagement.findFirst({
      where: {
        id: engagementId,
        fiscalYearId: this.fiscal.id,
        ...engagementVisibilityWhere(actor),
      },
      select: {
        id: true,
        staffId: true,
        natureOfWork: true,
        client: { select: { name: true } },
      },
    });
    if (!engagement) throw new NotFoundException();
    return engagement;
  }

  async list(engagementId: string, actor: CurrentUser) {
    await this.viewable(engagementId, actor);
    return this.prisma.documentRequest.findMany({
      where: { engagementId },
      include: relations,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async create(
    engagementId: string,
    input: CreateDocumentRequestDto,
    actor: CurrentUser,
  ) {
    const engagement = await this.viewable(engagementId, actor);
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.documentRequest.create({
        data: {
          engagementId,
          title: input.title,
          description: input.description ?? null,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          createdById: actor.id,
        },
        include: relations,
      });
      await this.activity.record(tx, {
        engagementId,
        actorId: actor.id,
        action: 'REQUEST_ADDED',
        summary: `Requested document "${request.title}" from ${engagement.client.name}.`,
      });
      await this.notifications.notify(tx, {
        userIds: [engagement.staffId],
        actorId: actor.id,
        type: 'REQUEST_ADDED',
        title: 'Document requested',
        message: `${engagement.client.name}: "${request.title}"`,
        engagementId,
      });
      return request;
    });
  }

  async update(
    id: string,
    input: UpdateDocumentRequestDto,
    actor: CurrentUser,
  ) {
    const current = await this.prisma.documentRequest.findFirst({
      where: {
        id,
        engagement: {
          fiscalYearId: this.fiscal.id,
          ...engagementVisibilityWhere(actor),
        },
      },
      include: {
        engagement: {
          select: { staffId: true, client: { select: { name: true } } },
        },
      },
    });
    if (!current) throw new NotFoundException();
    if (actor.role === 'STAFF') {
      const fields = Object.keys(input);
      if (fields.some((field) => !['status', 'reference'].includes(field)))
        throw new ForbiddenException(
          'STAFF can only mark a request received and note where it is kept',
        );
    }
    const receiving =
      input.status === 'RECEIVED' && current.status !== 'RECEIVED';
    const reopening =
      input.status === 'REQUESTED' && current.status !== 'REQUESTED';
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.documentRequest.update({
        where: { id },
        data: {
          title: input.title,
          description: input.description,
          dueDate:
            input.dueDate === undefined
              ? undefined
              : input.dueDate
                ? new Date(input.dueDate)
                : null,
          status: input.status,
          reference: input.reference,
          ...(receiving
            ? { receivedAt: new Date(), receivedById: actor.id }
            : reopening
              ? { receivedAt: null, receivedById: null }
              : {}),
        },
        include: relations,
      });
      if (receiving || reopening)
        await this.activity.record(tx, {
          engagementId: request.engagementId,
          actorId: actor.id,
          action: receiving ? 'REQUEST_RECEIVED' : 'REQUEST_REOPENED',
          summary: receiving
            ? `Received document "${request.title}"${request.reference ? ` (${request.reference})` : ''}.`
            : `Reopened document request "${request.title}".`,
        });
      if (receiving)
        await this.notifications.notify(tx, {
          userIds: [
            ...(await this.notifications.auditorIds(tx)),
            current.engagement.staffId,
          ],
          actorId: actor.id,
          type: 'REQUEST_RECEIVED',
          title: 'Document received',
          message: `${current.engagement.client.name}: "${request.title}"`,
          engagementId: request.engagementId,
        });
      return request;
    });
  }

  async remove(id: string, actor: CurrentUser) {
    const request = await this.prisma.documentRequest.findFirst({
      where: { id, engagement: { fiscalYearId: this.fiscal.id } },
    });
    if (!request) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      await tx.documentRequest.delete({ where: { id } });
      await this.activity.record(tx, {
        engagementId: request.engagementId,
        actorId: actor.id,
        action: 'REQUEST_REMOVED',
        summary: `Removed document request "${request.title}".`,
      });
    });
  }
}
