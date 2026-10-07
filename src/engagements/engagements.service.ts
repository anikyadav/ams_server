import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import { defaultEngagementTasks } from './default-tasks';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CurrentUser, safeUserSelect } from '../auth/access';
import { subTaskInclude } from '../subtasks/subtask-include';
import { isRequiredTask } from './default-tasks';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateEngagementDto,
  UpdateEngagementDto,
  UpdateEngagementProgressDto,
} from './engagements.dto';

const relations = {
  client: true,
  staff: { select: safeUserSelect },
  subTasks: {
    include: subTaskInclude,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  },
  documentRequests: {
    include: { receivedBy: { select: safeUserSelect } },
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

/**
 * Staff who are not the engagement's primary staff only see the sub-tasks
 * assigned to them (and the discussion on those), never colleagues' work.
 * Progress is calculated before this runs, so it still reflects the whole job.
 */
function presentFor<
  T extends {
    staffId: string;
    subTasks: { id: string; assignedToId: string }[];
    comments: { subTaskId: string | null }[];
  },
>(record: T, actor: CurrentUser): T {
  if (actor.role === 'AUDITOR' || record.staffId === actor.id) return record;
  const subTasks = record.subTasks.filter(
    (task) => task.assignedToId === actor.id,
  );
  const visible = new Set(subTasks.map((task) => task.id));
  return {
    ...record,
    subTasks,
    comments: record.comments.filter(
      (comment) => !comment.subTaskId || visible.has(comment.subTaskId),
    ),
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
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
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
    return records.map((record) => presentFor(withProgress(record), actor));
  }

  async findOne(id: string, actor: CurrentUser) {
    const record = await this.prisma.engagement.findFirstOrThrow({
      where: { id, ...this.scope(actor) },
      include: relations,
    });
    return presentFor(withProgress(record), actor);
  }

  async create(input: CreateEngagementDto, actorId: string) {
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
      await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.engagement.create({
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
              subTasks: { create: defaultEngagementTasks(input.staffId) },
              status: input.status,
              startDate,
              targetDate,
              priority: input.priority,
            },
            include: relations,
          });
          await this.activity.record(tx, {
            engagementId: created.id,
            actorId,
            action: 'ENGAGEMENT_CREATED',
            summary: `Created engagement "${created.natureOfWork}" for ${created.client.name}, assigned to ${created.staff.name}.`,
          });
          await tx.activityLog.createMany({
            data: created.subTasks.map((task) => ({
              engagementId: created.id,
              actorId,
              subTaskId: task.id,
              action: 'SUBTASK_CREATED',
              summary: `Created compulsory sub-task "${task.title}" assigned to ${created.staff.name}.`,
            })),
          });
          await this.notifications.notify(tx, {
            userIds: [created.staffId],
            actorId,
            type: 'ENGAGEMENT_ASSIGNED',
            title: 'New engagement assigned',
            message: `${created.client.name} — ${created.natureOfWork}`,
            engagementId: created.id,
          });
          return created;
        },
        { timeout: 15_000 },
      ),
    );
  }

  /** Compulsory tasks must be signed off before an engagement can be completed. */
  private async assertSignedOff(
    tx: Prisma.TransactionClient,
    engagementId: string,
  ) {
    const tasks = await tx.subTask.findMany({
      where: { engagementId },
      select: { title: true, templateKey: true, reviewState: true },
    });
    const pending = tasks.filter(
      (task) =>
        isRequiredTask(task.templateKey) && task.reviewState !== 'APPROVED',
    );
    if (pending.length)
      throw new BadRequestException(
        `Compulsory tasks need auditor approval before completion: ${pending.map((task) => task.title).join(', ')}`,
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
      if (input.progress === 100) await this.assertSignedOff(tx, id);
      await tx.engagement.update({
        where,
        data: {
          manualProgress: input.progress,
          status: input.progress === 100 ? 'COMPLETE' : 'IN_PROGRESS',
        },
      });
      await this.activity.record(tx, {
        engagementId: id,
        actorId: actor.id,
        action: 'PROGRESS_UPDATED',
        summary: `Set engagement progress to ${input.progress}%${input.progress === 100 ? ' (marked complete)' : ''}.`,
      });
      await this.notifications.notify(tx, {
        userIds: await this.notifications.auditorIds(tx),
        actorId: actor.id,
        type: 'PROGRESS_UPDATE',
        title:
          input.progress === 100
            ? 'Engagement marked complete'
            : 'Engagement progress updated',
        message: `${actor.name} set "${current.natureOfWork}" to ${input.progress}%.`,
        engagementId: id,
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

  async update(id: string, input: UpdateEngagementDto, actorId: string) {
    const current = await this.prisma.engagement.findUnique({
      where: { id, fiscalYearId: this.fiscal.id },
      include: { client: true, staff: true },
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

    const changes: string[] = [];
    if (input.status && input.status !== current.status)
      changes.push(`status ${current.status} → ${input.status}`);
    if (input.staffId && input.staffId !== current.staffId) {
      const next = await this.prisma.user.findUnique({
        where: { id: input.staffId },
      });
      changes.push(`primary staff ${current.staff.name} → ${next?.name}`);
    }
    if (input.clientId && input.clientId !== current.clientId)
      changes.push('client changed');
    if (input.natureOfWork && input.natureOfWork !== current.natureOfWork)
      changes.push(`work "${current.natureOfWork}" → "${input.natureOfWork}"`);
    const day = (date: Date | null) =>
      date?.toISOString().slice(0, 10) ?? 'none';
    if (
      input.targetDate !== undefined &&
      day(targetDate) !== day(current.targetDate)
    )
      changes.push(
        `target date ${day(current.targetDate)} → ${day(targetDate)}`,
      );
    if (
      input.startDate !== undefined &&
      day(startDate) !== day(current.startDate)
    )
      changes.push(`start date ${day(current.startDate)} → ${day(startDate)}`);
    if (input.priority !== undefined && input.priority !== current.priority)
      changes.push(
        `priority ${current.priority ?? 'none'} → ${input.priority ?? 'none'}`,
      );

    return withProgress(
      await this.prisma.$transaction(async (tx) => {
        if (
          (input.status === 'COMPLETE' || input.status === 'DELIVERED') &&
          input.status !== current.status &&
          current.status !== 'COMPLETE' &&
          current.status !== 'DELIVERED'
        )
          await this.assertSignedOff(tx, id);
        const updated = await tx.engagement.update({
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
        });
        if (changes.length)
          await this.activity.record(tx, {
            engagementId: id,
            actorId,
            action: 'ENGAGEMENT_UPDATED',
            summary: `Updated ${changes.join('; ')}.`,
          });
        const assignees = await tx.subTask.findMany({
          where: { engagementId: id },
          select: { assignedToId: true },
        });
        const label = `${current.client.name} — ${updated.natureOfWork}`;
        if (input.staffId && input.staffId !== current.staffId)
          await this.notifications.notify(tx, {
            userIds: [input.staffId],
            actorId,
            type: 'ENGAGEMENT_ASSIGNED',
            title: 'Engagement assigned to you',
            message: label,
            engagementId: id,
          });
        const watchers = [
          updated.staffId,
          ...assignees.map((task) => task.assignedToId),
        ].filter((userId) => userId !== input.staffId);
        const statusChanged = input.status && input.status !== current.status;
        const datesChanged =
          (input.targetDate !== undefined &&
            day(targetDate) !== day(current.targetDate)) ||
          (input.startDate !== undefined &&
            day(startDate) !== day(current.startDate));
        if (statusChanged || datesChanged)
          await this.notifications.notify(tx, {
            userIds: watchers,
            actorId,
            type: 'ENGAGEMENT_UPDATED',
            title: statusChanged
              ? 'Engagement status changed'
              : 'Engagement dates changed',
            message: `${label}: ${changes.join('; ')}.`,
            engagementId: id,
          });
        return updated;
      }),
    );
  }

  /** People the actor may @mention: auditors, the lead and assignees they can see. */
  async participants(id: string, actor: CurrentUser) {
    const engagement = await this.prisma.engagement.findFirstOrThrow({
      where: { id, ...this.scope(actor) },
      select: {
        staffId: true,
        subTasks: { select: { assignedToId: true } },
      },
    });
    const seesAll = actor.role === 'AUDITOR' || engagement.staffId === actor.id;
    const ids = new Set([
      engagement.staffId,
      actor.id,
      ...(seesAll ? engagement.subTasks.map((task) => task.assignedToId) : []),
    ]);
    return this.prisma.user.findMany({
      where: { OR: [{ role: 'AUDITOR' }, { id: { in: [...ids] } }] },
      select: { id: true, name: true, role: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async activityFor(id: string, actor: CurrentUser) {
    const engagement = await this.prisma.engagement.findFirstOrThrow({
      where: { id, ...this.scope(actor) },
      select: { id: true, staffId: true },
    });
    if (actor.role === 'AUDITOR' || engagement.staffId === actor.id)
      return this.activity.list({ engagementId: id });
    // Other staff see only their own actions and changes to their own tasks.
    const mine = await this.prisma.subTask.findMany({
      where: { engagementId: id, assignedToId: actor.id },
      select: { id: true },
    });
    return this.activity.list({
      engagementId: id,
      OR: [
        { actorId: actor.id },
        { subTaskId: { in: mine.map((task) => task.id) } },
      ],
    });
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
