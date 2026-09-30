import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CurrentUser, safeUserSelect } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateEngagementDto,
  UpdateEngagementDto,
  UpdateEngagementProgressDto,
} from './engagements.dto';

const relations = {
  client: true,
  staff: { select: safeUserSelect },
  subTasks: {
    include: { assignedTo: { select: safeUserSelect } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
  comments: {
    include: { author: { select: safeUserSelect } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.EngagementInclude;

function withProgress<
  T extends {
    manualProgress: number | null;
    status: string;
    subTasks: { progress: number }[];
  },
>(record: T) {
  return {
    ...record,
    progress:
      record.status === 'COMPLETE' || record.status === 'DELIVERED'
        ? 100
        : (record.manualProgress ??
          (record.subTasks.length
            ? Math.round(
                record.subTasks.reduce((sum, task) => sum + task.progress, 0) /
                  record.subTasks.length,
              )
            : 0)),
  };
}

function staffWhere(actor: CurrentUser): Prisma.EngagementWhereInput {
  return actor.role === 'AUDITOR'
    ? {}
    : {
        OR: [
          { staffId: actor.id },
          { subTasks: { some: { assignedToId: actor.id } } },
        ],
      };
}

@Injectable()
export class EngagementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
  ) {}

  private scope(actor: CurrentUser): Prisma.EngagementWhereInput {
    return { ...staffWhere(actor), fiscalYearId: this.fiscal.id };
  }

  async list(actor: CurrentUser) {
    const records = await this.prisma.engagement.findMany({
      where: this.scope(actor),
      include: relations,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return records.map(withProgress);
  }

  async findOne(id: string, actor: CurrentUser) {
    const record = await this.prisma.engagement.findFirstOrThrow({
      where: { id, ...this.scope(actor) },
      include: relations,
    });
    return withProgress(record);
  }

  async create(input: CreateEngagementDto) {
    if (this.fiscal.id === 'legacy')
      throw new BadRequestException(
        'Select a fiscal year before creating new records',
      );
    await this.validateReferences(input);
    const startDate =
      input.startDate === null
        ? null
        : input.startDate === undefined
          ? undefined
          : new Date(input.startDate);
    const targetDate =
      input.targetDate === null
        ? null
        : input.targetDate === undefined
          ? undefined
          : new Date(input.targetDate);
    if (startDate && targetDate && targetDate < startDate)
      throw new BadRequestException('Target date cannot precede start date');
    return withProgress(
      await this.prisma.engagement.create({
        data: {
          fiscalYear: { connect: { id: this.fiscal.id } },
          client: {
            connect: {
              id_fiscalYearId: {
                id: input.clientId,
                fiscalYearId: this.fiscal.id,
              },
            },
          },
          staff: { connect: { id: input.staffId } },
          natureOfWork: input.natureOfWork,
          status: input.status,
          startDate,
          targetDate,
          priority: input.priority,
        },
        include: relations,
      }),
    );
  }

  async updateProgress(
    id: string,
    input: UpdateEngagementProgressDto,
    actor: CurrentUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const where = {
        id,
        fiscalYearId: this.fiscal.id,
        ...(actor.role === 'AUDITOR' ? {} : { staffId: actor.id }),
      };
      const current = await tx.engagement.findFirst({ where });
      if (!current)
        throw new NotFoundException('Assigned engagement not found');
      if (current.status === 'DELIVERED')
        throw new BadRequestException(
          'Delivered engagements must be reopened by an auditor before updating progress',
        );
      await tx.engagement.update({
        where,
        data: {
          manualProgress: input.progress,
          status: input.progress === 100 ? 'COMPLETE' : 'IN_PROGRESS',
        },
      });
      await tx.comment.create({
        data: {
          engagementId: id,
          authorId: actor.id,
          text: [
            `Engagement progress updated to ${input.progress}% (${input.progress === 100 ? 'Complete' : 'In progress'}).`,
            input.comment,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      });
      return withProgress(
        await tx.engagement.findUniqueOrThrow({
          where: { id },
          include: relations,
        }),
      );
    });
  }

  async update(id: string, input: UpdateEngagementDto) {
    const current = await this.prisma.engagement.findUnique({
      where: { id, fiscalYearId: this.fiscal.id },
    });
    if (!current) throw new NotFoundException('Engagement not found');

    const startDate =
      input.startDate === null
        ? null
        : input.startDate === undefined
          ? current.startDate
          : new Date(input.startDate);
    const targetDate =
      input.targetDate === null
        ? null
        : input.targetDate === undefined
          ? current.targetDate
          : new Date(input.targetDate);
    if (startDate && targetDate && targetDate < startDate)
      throw new BadRequestException('Target date cannot precede start date');
    await this.validateReferences({
      clientId: input.clientId ?? current.clientId,
      staffId: input.staffId ?? current.staffId,
      natureOfWork: input.natureOfWork ?? current.natureOfWork,
    });

    return withProgress(
      await this.prisma.engagement.update({
        where: { id, fiscalYearId: this.fiscal.id },
        data: {
          clientId: input.clientId,
          staffId: input.staffId,
          natureOfWork: input.natureOfWork,
          status: input.status,
          manualProgress:
            input.status === undefined
              ? undefined
              : input.status === 'COMPLETE' || input.status === 'DELIVERED'
                ? 100
                : input.status === 'NOT_STARTED'
                  ? 0
                  : current.manualProgress === 100
                    ? 75
                    : undefined,
          startDate,
          targetDate,
          priority: input.priority,
        },
        include: relations,
      }),
    );
  }

  async remove(id: string) {
    try {
      await this.prisma.engagement.delete({
        where: { id, fiscalYearId: this.fiscal.id },
      });
    } catch {
      throw new NotFoundException('Engagement not found');
    }
  }

  private async validateReferences(input: CreateEngagementDto) {
    const client = await this.prisma.client.findUnique({
      where: { id: input.clientId, fiscalYearId: this.fiscal.id },
    });
    if (!client) throw new BadRequestException('Client does not exist');
    const staff = await this.prisma.user.findUnique({
      where: { id: input.staffId },
    });
    if (!staff || staff.role !== 'STAFF')
      throw new BadRequestException('Assigned staff does not exist');
  }
}
