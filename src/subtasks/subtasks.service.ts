import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SubTaskStatus } from '../generated/prisma/client';
import { safeUserSelect, type CurrentUser } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateSubTaskDto, UpdateSubTaskDto } from './subtasks.dto';

const relations = {
  assignedTo: { select: safeUserSelect },
} satisfies Prisma.SubTaskInclude;

// Staff see their own sub-tasks, and every sub-task of engagements they lead.
const visibleWhere = (actor: CurrentUser): Prisma.SubTaskWhereInput =>
  actor.role === 'AUDITOR'
    ? {}
    : {
        OR: [{ assignedToId: actor.id }, { engagement: { staffId: actor.id } }],
      };

const PROGRESS_STEPS = [0, 25, 50, 75, 100];

function statusFromProgress(progress: number): SubTaskStatus {
  if (progress === 0) return 'TODO';
  if (progress === 100) return 'DONE';
  return 'IN_PROGRESS';
}

function progressFromStatus(status: SubTaskStatus): number | null {
  if (status === 'DONE') return 100;
  if (status === 'TODO') return 0;
  return null;
}

@Injectable()
export class SubtasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(engagementId: string, input: CreateSubTaskDto, actorId: string) {
    await this.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId, fiscalYearId: this.fiscal.id },
    });
    await this.assertAssigneeIsStaff(input.assignedToId);
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.subTask.create({
        data: {
          engagement: { connect: { id: engagementId } },
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          priority: input.priority,
          title: input.title,
          description: input.description ?? null,
          assignedTo: { connect: { id: input.assignedToId } },
        },
        include: relations,
      });
      await this.activity.record(tx, {
        engagementId,
        actorId,
        subTaskId: task.id,
        action: 'SUBTASK_CREATED',
        summary: `Added sub-task "${task.title}" assigned to ${task.assignedTo.name}.`,
      });
      await this.notifications.notify(tx, {
        userIds: [task.assignedToId],
        actorId,
        type: 'TASK_ASSIGNED',
        title: 'New task assigned',
        message: `"${task.title}"${task.dueDate ? ` — due ${task.dueDate.toISOString().slice(0, 10)}` : ''}`,
        engagementId,
        subTaskId: task.id,
      });
      return task;
    });
  }

  /** A single task with its engagement context, if the actor may see it. */
  async findOne(id: string, actor: CurrentUser) {
    const task = await this.prisma.subTask.findFirst({
      where: {
        id,
        engagement: { fiscalYearId: this.fiscal.id },
        ...visibleWhere(actor),
      },
      include: {
        ...relations,
        engagement: {
          select: {
            id: true,
            natureOfWork: true,
            status: true,
            staffId: true,
            client: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!task) throw new NotFoundException();
    return task;
  }

  async activityFor(id: string, actor: CurrentUser) {
    await this.findOne(id, actor);
    return this.activity.list({ subTaskId: id });
  }

  async listByEngagement(engagementId: string, actor: CurrentUser) {
    return this.prisma.subTask.findMany({
      where: {
        engagementId,
        engagement: { fiscalYearId: this.fiscal.id },
        ...visibleWhere(actor),
      },
      include: relations,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async update(id: string, input: UpdateSubTaskDto, actor: CurrentUser) {
    const current = await this.prisma.subTask.findUnique({
      where: { id, engagement: { fiscalYearId: this.fiscal.id } },
    });
    if (!current) throw new NotFoundException();

    if (actor.role === 'AUDITOR') {
      if (input.assignedToId !== undefined)
        await this.assertAssigneeIsStaff(input.assignedToId);
    } else {
      if (current.assignedToId !== actor.id) throw new NotFoundException();
      const fields = Object.keys(input).filter((field) => field !== 'comment');
      if (fields.length !== 1 || !['status', 'progress'].includes(fields[0]))
        throw new ForbiddenException(
          'STAFF can only update status or progress with an optional comment on their own subtasks',
        );
    }
    this.assertValidStatus(input.status);
    this.assertValidProgress(input.progress);
    const data = this.resolveFields(current, input);
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.subTask.update({
        where: {
          id,
          engagement: { fiscalYearId: this.fiscal.id },
          ...(actor.role === 'STAFF' ? { assignedToId: actor.id } : {}),
        },
        data,
        include: relations,
      });
      const changes: string[] = [];
      if (task.status !== current.status)
        changes.push(`status ${current.status} → ${task.status}`);
      if (task.assignedToId !== current.assignedToId)
        changes.push(`reassigned to ${task.assignedTo.name}`);
      if (task.title !== current.title) changes.push('title changed');
      if (input.dueDate !== undefined) changes.push('due date changed');
      if (input.priority !== undefined && task.priority !== current.priority)
        changes.push(`priority ${current.priority} → ${task.priority}`);
      if (changes.length)
        await this.activity.record(tx, {
          engagementId: task.engagementId,
          actorId: actor.id,
          subTaskId: task.id,
          action: 'SUBTASK_UPDATED',
          summary: `Sub-task "${task.title}": ${changes.join('; ')}.`,
        });
      const reassigned = task.assignedToId !== current.assignedToId;
      if (reassigned)
        await this.notifications.notify(tx, {
          userIds: [task.assignedToId],
          actorId: actor.id,
          type: 'TASK_ASSIGNED',
          title: 'Task assigned to you',
          message: `"${task.title}"`,
          engagementId: task.engagementId,
          subTaskId: task.id,
        });
      if (actor.role === 'AUDITOR') {
        if (!reassigned && changes.length)
          await this.notifications.notify(tx, {
            userIds: [task.assignedToId],
            actorId: actor.id,
            type: 'TASK_UPDATED',
            title: 'Your task was updated',
            message: `"${task.title}": ${changes.join('; ')}.`,
            engagementId: task.engagementId,
            subTaskId: task.id,
          });
      } else if (
        task.status !== current.status ||
        task.progress !== current.progress
      ) {
        const engagement = await tx.engagement.findUniqueOrThrow({
          where: { id: task.engagementId },
          select: { staffId: true },
        });
        await this.notifications.notify(tx, {
          userIds: [
            ...(await this.notifications.auditorIds(tx)),
            engagement.staffId,
          ],
          actorId: actor.id,
          type: task.status === 'DONE' ? 'TASK_COMPLETED' : 'TASK_PROGRESS',
          title:
            task.status === 'DONE' ? 'Task completed' : 'Task progress updated',
          message: `${actor.name}: "${task.title}" is now ${task.progress}%.`,
          engagementId: task.engagementId,
          subTaskId: task.id,
        });
      }
      if (
        input.progress !== undefined ||
        input.status !== undefined ||
        input.comment
      ) {
        const milestone =
          input.progress !== undefined || input.status !== undefined
            ? `Progress updated to ${task.progress}% (${task.status === 'DONE' ? 'Complete' : task.status === 'TODO' ? 'Not started' : 'In progress'}).`
            : '';
        await tx.comment.create({
          data: {
            engagementId: task.engagementId,
            subTaskId: task.id,
            authorId: actor.id,
            text: [milestone, input.comment].filter(Boolean).join('\n'),
          },
        });
      }
      return task;
    });
  }

  private resolveFields(
    current: { status: SubTaskStatus; progress: number },
    input: UpdateSubTaskDto,
  ) {
    if (
      input.status !== undefined &&
      input.progress !== undefined &&
      statusFromProgress(input.progress) !== input.status
    )
      throw new BadRequestException('Status and progress must agree');
    const progress =
      input.progress ??
      (input.status !== undefined
        ? (progressFromStatus(input.status) ??
          (current.progress > 0 && current.progress < 100
            ? current.progress
            : 25))
        : current.progress);
    const status = statusFromProgress(progress);
    return {
      dueDate:
        input.dueDate === undefined
          ? undefined
          : input.dueDate
            ? new Date(input.dueDate)
            : null,
      priority: input.priority,
      title: input.title,
      description:
        input.description === undefined ? undefined : input.description,
      status,
      progress,
      completedAt:
        status === 'DONE'
          ? current.status === 'DONE'
            ? undefined
            : new Date()
          : null,
      assignedToId: input.assignedToId,
    };
  }

  async remove(id: string, actorId: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const task = await tx.subTask.delete({
          where: { id, engagement: { fiscalYearId: this.fiscal.id } },
        });
        await this.activity.record(tx, {
          engagementId: task.engagementId,
          actorId,
          subTaskId: task.id,
          action: 'SUBTASK_DELETED',
          summary: `Deleted sub-task "${task.title}".`,
        });
        await this.notifications.notify(tx, {
          userIds: [task.assignedToId],
          actorId,
          type: 'TASK_REMOVED',
          title: 'Task removed',
          message: `"${task.title}" was removed from your work.`,
          engagementId: task.engagementId,
        });
      });
    } catch {
      throw new NotFoundException();
    }
  }

  private assertValidStatus(status?: SubTaskStatus) {
    if (
      status !== undefined &&
      !['TODO', 'IN_PROGRESS', 'DONE'].includes(status)
    )
      throw new BadRequestException('Invalid subtask status');
  }

  private assertValidProgress(progress?: number) {
    if (progress !== undefined && !PROGRESS_STEPS.includes(progress))
      throw new BadRequestException(
        'Invalid subtask progress; expected 0, 25, 50, 75 or 100',
      );
  }

  private async assertAssigneeIsStaff(userId: string | undefined) {
    if (userId === undefined) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'STAFF')
      throw new BadRequestException(
        'Assigned user must be an existing STAFF member',
      );
  }
}
