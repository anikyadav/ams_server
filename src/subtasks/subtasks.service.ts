import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import { isRequiredTask } from '../engagements/default-tasks';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SubTaskStatus } from '../generated/prisma/client';
import type { CurrentUser } from '../auth/access';
import { subTaskInclude } from './subtask-include';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateChecklistItemDto,
  CreateSubTaskDto,
  ReviewSubTaskDto,
  UpdateChecklistItemDto,
  UpdateSubTaskDto,
} from './subtasks.dto';

const relations = subTaskInclude;

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

const STATUS_LABEL: Record<SubTaskStatus, string> = {
  TODO: 'Not started',
  IN_PROGRESS: 'In progress',
  DONE: 'Completed',
};

const formatDay = (date: Date | null) =>
  date ? date.toISOString().slice(0, 10) : 'none';

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
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
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
      if (
        fields.length !== 1 ||
        !['status', 'progress', 'blockedReason'].includes(fields[0])
      )
        throw new ForbiddenException(
          'STAFF can only update status, progress or the blocked flag with an optional comment on their own subtasks',
        );
    }
    this.assertValidStatus(input.status);
    this.assertValidProgress(input.progress);
    const data = this.resolveFields(current, input, actor);
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
      if (task.progress !== current.progress)
        changes.push(`progress ${current.progress}% → ${task.progress}%`);
      if (task.status !== current.status)
        changes.push(
          `status ${STATUS_LABEL[current.status]} → ${STATUS_LABEL[task.status]}`,
        );
      if (task.assignedToId !== current.assignedToId)
        changes.push(`reassigned to ${task.assignedTo.name}`);
      if (task.title !== current.title)
        changes.push(`title "${current.title}" → "${task.title}"`);
      if (
        input.description !== undefined &&
        (task.description ?? '') !== (current.description ?? '')
      )
        changes.push('description edited');
      if (formatDay(task.dueDate) !== formatDay(current.dueDate))
        changes.push(
          `due date ${formatDay(current.dueDate)} → ${formatDay(task.dueDate)}`,
        );
      if (input.priority !== undefined && task.priority !== current.priority)
        changes.push(`priority ${current.priority} → ${task.priority}`);
      if (task.blockedReason !== current.blockedReason)
        changes.push(
          task.blockedReason
            ? `blocked: ${task.blockedReason}`
            : 'no longer blocked',
        );
      if (task.reviewState !== current.reviewState) {
        if (task.reviewState === 'SUBMITTED')
          changes.push('submitted for review');
        else if (task.reviewState === 'APPROVED') changes.push('approved');
      }
      const note = input.comment?.trim();
      const completed = task.status === 'DONE' && current.status !== 'DONE';
      const reopened = task.status !== 'DONE' && current.status === 'DONE';
      if (changes.length || note) {
        const action = completed
          ? 'SUBTASK_COMPLETED'
          : reopened
            ? 'SUBTASK_REOPENED'
            : task.progress !== current.progress
              ? 'SUBTASK_PROGRESS'
              : changes.length
                ? 'SUBTASK_UPDATED'
                : 'SUBTASK_NOTE';
        const headline = completed
          ? `Completed sub-task "${task.title}"`
          : reopened
            ? `Reopened sub-task "${task.title}"`
            : `Sub-task "${task.title}"`;
        // The first line is the headline; any further lines are the user's note.
        const summary = [
          changes.length
            ? `${headline}: ${changes.join('; ')}.`
            : `${headline}: note added.`,
          note ? `Note: ${note}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        await this.activity.record(tx, {
          engagementId: task.engagementId,
          actorId: actor.id,
          subTaskId: task.id,
          action,
          summary,
        });
      }
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
        await this.notifyProgress(tx, task, actor);
      }
      if (task.blockedReason !== current.blockedReason)
        await this.notifyBlocked(tx, task, actor);
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

  /** Sign-off bookkeeping when a task is completed or reopened. */
  private reviewFields(
    current: { status: SubTaskStatus },
    next: SubTaskStatus,
    actor: CurrentUser,
  ): Prisma.SubTaskUncheckedUpdateInput {
    if (next === 'DONE' && current.status !== 'DONE') {
      const now = new Date();
      // An auditor completing work is the reviewer; staff completing it submits it.
      return actor.role === 'AUDITOR'
        ? {
            reviewState: 'APPROVED',
            reviewedAt: now,
            reviewedById: actor.id,
            reviewNote: null,
            submittedAt: null,
            submittedById: null,
            blockedReason: null,
            blockedAt: null,
          }
        : {
            reviewState: 'SUBMITTED',
            submittedAt: now,
            submittedById: actor.id,
            reviewedAt: null,
            reviewedById: null,
            reviewNote: null,
            blockedReason: null,
            blockedAt: null,
          };
    }
    if (next !== 'DONE' && current.status === 'DONE')
      return {
        reviewState: 'NOT_SUBMITTED',
        submittedAt: null,
        submittedById: null,
        reviewedAt: null,
        reviewedById: null,
        reviewNote: null,
      };
    return {};
  }

  private resolveFields(
    current: {
      status: SubTaskStatus;
      progress: number;
      blockedAt: Date | null;
    },
    input: UpdateSubTaskDto,
    actor: CurrentUser,
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
    const blocked =
      input.blockedReason === undefined
        ? {}
        : {
            blockedReason: input.blockedReason,
            blockedAt: input.blockedReason
              ? (current.blockedAt ?? new Date())
              : null,
          };
    return {
      ...blocked,
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
      ...this.reviewFields(current, status, actor),
    };
  }

  private async notifyProgress(
    tx: Prisma.TransactionClient,
    task: {
      id: string;
      title: string;
      status: SubTaskStatus;
      progress: number;
      engagementId: string;
      reviewState: string;
    },
    actor: CurrentUser,
  ) {
    const engagement = await tx.engagement.findUniqueOrThrow({
      where: { id: task.engagementId },
      select: { staffId: true },
    });
    const submitted = task.reviewState === 'SUBMITTED';
    await this.notifications.notify(tx, {
      userIds: [
        ...(await this.notifications.auditorIds(tx)),
        engagement.staffId,
      ],
      actorId: actor.id,
      type: submitted
        ? 'TASK_SUBMITTED'
        : task.status === 'DONE'
          ? 'TASK_COMPLETED'
          : 'TASK_PROGRESS',
      title: submitted
        ? 'Task submitted for review'
        : task.status === 'DONE'
          ? 'Task completed'
          : 'Task progress updated',
      message: submitted
        ? `${actor.name} submitted "${task.title}" for review.`
        : `${actor.name}: "${task.title}" is now ${task.progress}%.`,
      engagementId: task.engagementId,
      subTaskId: task.id,
    });
  }

  private async notifyBlocked(
    tx: Prisma.TransactionClient,
    task: {
      id: string;
      title: string;
      blockedReason: string | null;
      assignedToId: string;
      engagementId: string;
    },
    actor: CurrentUser,
  ) {
    const engagement = await tx.engagement.findUniqueOrThrow({
      where: { id: task.engagementId },
      select: { staffId: true },
    });
    await this.notifications.notify(tx, {
      userIds: [
        ...(await this.notifications.auditorIds(tx)),
        engagement.staffId,
        task.assignedToId,
      ],
      actorId: actor.id,
      type: 'TASK_BLOCKED',
      title: task.blockedReason ? 'Task blocked' : 'Task unblocked',
      message: task.blockedReason
        ? `${actor.name}: "${task.title}" is blocked — ${task.blockedReason}`
        : `${actor.name}: "${task.title}" is no longer blocked.`,
      engagementId: task.engagementId,
      subTaskId: task.id,
    });
  }

  /** Auditor decision on a submitted task: sign it off, or send it back with a note. */
  async review(id: string, input: ReviewSubTaskDto, actor: CurrentUser) {
    const current = await this.prisma.subTask.findFirst({
      where: { id, engagement: { fiscalYearId: this.fiscal.id } },
    });
    if (!current) throw new NotFoundException();
    if (current.reviewState !== 'SUBMITTED')
      throw new BadRequestException('This task is not awaiting review');
    const approve = input.decision === 'APPROVE';
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.subTask.update({
        where: { id },
        data: approve
          ? {
              reviewState: 'APPROVED',
              reviewedAt: now,
              reviewedById: actor.id,
              reviewNote: input.note ?? null,
            }
          : {
              reviewState: 'CHANGES_REQUESTED',
              reviewedAt: now,
              reviewedById: actor.id,
              reviewNote: input.note,
              status: 'IN_PROGRESS',
              progress: 75,
              completedAt: null,
            },
        include: relations,
      });
      await this.activity.record(tx, {
        engagementId: task.engagementId,
        actorId: actor.id,
        subTaskId: task.id,
        action: approve ? 'SUBTASK_APPROVED' : 'SUBTASK_CHANGES_REQUESTED',
        summary: [
          approve
            ? `Approved sub-task "${task.title}".`
            : `Requested changes on sub-task "${task.title}".`,
          input.note ? `Note: ${input.note}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      if (!approve)
        await tx.comment.create({
          data: {
            engagementId: task.engagementId,
            subTaskId: task.id,
            authorId: actor.id,
            text: `Changes requested:\n${input.note}`,
          },
        });
      await this.notifications.notify(tx, {
        userIds: [task.assignedToId],
        actorId: actor.id,
        type: approve ? 'TASK_APPROVED' : 'TASK_CHANGES_REQUESTED',
        title: approve ? 'Task approved' : 'Changes requested',
        message: approve
          ? `"${task.title}" was approved.`
          : `"${task.title}": ${input.note}`,
        engagementId: task.engagementId,
        subTaskId: task.id,
      });
      return task;
    });
  }

  // ---- checklist ----------------------------------------------------------

  async addChecklistItem(
    taskId: string,
    input: CreateChecklistItemDto,
    actor: CurrentUser,
  ) {
    const task = await this.prisma.subTask.findFirst({
      where: { id: taskId, engagement: { fiscalYearId: this.fiscal.id } },
      include: { checklist: { select: { sortOrder: true } } },
    });
    if (!task) throw new NotFoundException();
    const sortOrder =
      Math.max(0, ...task.checklist.map((item) => item.sortOrder)) + 10;
    return this.prisma.$transaction(async (tx) => {
      await tx.taskChecklistItem.create({
        data: { subTaskId: taskId, text: input.text, sortOrder },
      });
      await this.activity.record(tx, {
        engagementId: task.engagementId,
        actorId: actor.id,
        subTaskId: taskId,
        action: 'SUBTASK_CHECKLIST',
        summary: `Added step "${input.text}" to "${task.title}".`,
      });
      return this.syncProgress(tx, taskId, actor);
    });
  }

  async updateChecklistItem(
    itemId: string,
    input: UpdateChecklistItemDto,
    actor: CurrentUser,
  ) {
    const item = await this.prisma.taskChecklistItem.findFirst({
      where: {
        id: itemId,
        subTask: { engagement: { fiscalYearId: this.fiscal.id } },
      },
      include: { subTask: true },
    });
    if (!item) throw new NotFoundException();
    if (actor.role === 'STAFF') {
      if (item.subTask.assignedToId !== actor.id) throw new NotFoundException();
      if (input.text !== undefined)
        throw new ForbiddenException('STAFF can only tick or untick steps');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.taskChecklistItem.update({
        where: { id: itemId },
        data: {
          text: input.text,
          ...(input.done === undefined || input.done === item.done
            ? {}
            : input.done
              ? { done: true, doneAt: new Date(), doneById: actor.id }
              : { done: false, doneAt: null, doneById: null }),
        },
      });
      if (input.done !== undefined && input.done !== item.done) {
        const siblings = await tx.taskChecklistItem.findMany({
          where: { subTaskId: item.subTaskId },
          select: { done: true },
        });
        await this.activity.record(tx, {
          engagementId: item.subTask.engagementId,
          actorId: actor.id,
          subTaskId: item.subTaskId,
          action: 'SUBTASK_CHECKLIST',
          summary: `${input.done ? 'Completed' : 'Reopened'} step "${item.text}" on "${item.subTask.title}" (${siblings.filter((entry) => entry.done).length}/${siblings.length}).`,
        });
      }
      return this.syncProgress(tx, item.subTaskId, actor);
    });
  }

  async removeChecklistItem(itemId: string, actor: CurrentUser) {
    const item = await this.prisma.taskChecklistItem.findFirst({
      where: {
        id: itemId,
        subTask: { engagement: { fiscalYearId: this.fiscal.id } },
      },
      include: { subTask: true },
    });
    if (!item) throw new NotFoundException();
    return this.prisma.$transaction(async (tx) => {
      await tx.taskChecklistItem.delete({ where: { id: itemId } });
      await this.activity.record(tx, {
        engagementId: item.subTask.engagementId,
        actorId: actor.id,
        subTaskId: item.subTaskId,
        action: 'SUBTASK_CHECKLIST',
        summary: `Removed step "${item.text}" from "${item.subTask.title}".`,
      });
      return this.syncProgress(tx, item.subTaskId, actor);
    });
  }

  /**
   * With steps, progress follows them: each quarter of the steps moves the task
   * one milestone, and the last step completes it (submitting it for review).
   */
  private async syncProgress(
    tx: Prisma.TransactionClient,
    taskId: string,
    actor: CurrentUser,
  ) {
    const task = await tx.subTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { checklist: { select: { done: true } } },
    });
    const total = task.checklist.length;
    if (total) {
      const done = task.checklist.filter((item) => item.done).length;
      const progress =
        done === total ? 100 : Math.floor((done / total) * 4) * 25;
      if (progress !== task.progress) {
        const status = statusFromProgress(progress);
        const updated = await tx.subTask.update({
          where: { id: taskId },
          data: {
            progress,
            status,
            completedAt:
              status === 'DONE'
                ? task.status === 'DONE'
                  ? undefined
                  : new Date()
                : null,
            ...this.reviewFields(task, status, actor),
          },
        });
        const completed = updated.status === 'DONE' && task.status !== 'DONE';
        const reopened = updated.status !== 'DONE' && task.status === 'DONE';
        if (completed || reopened)
          await this.activity.record(tx, {
            engagementId: task.engagementId,
            actorId: actor.id,
            subTaskId: taskId,
            action: completed ? 'SUBTASK_COMPLETED' : 'SUBTASK_REOPENED',
            summary: completed
              ? `Completed sub-task "${task.title}": all steps done${updated.reviewState === 'SUBMITTED' ? '; submitted for review' : ''}.`
              : `Reopened sub-task "${task.title}": a step is no longer done.`,
          });
        if (actor.role === 'STAFF' && completed)
          await this.notifyProgress(tx, updated, actor);
      }
    }
    return tx.subTask.findUniqueOrThrow({
      where: { id: taskId },
      include: relations,
    });
  }

  async remove(id: string, actorId: string) {
    const existing = await this.prisma.subTask.findFirst({
      where: { id, engagement: { fiscalYearId: this.fiscal.id } },
    });
    if (!existing) throw new NotFoundException();
    if (isRequiredTask(existing.templateKey))
      throw new BadRequestException(
        'Compulsory engagement tasks cannot be deleted. Create additional sub-tasks for extra work.',
      );
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
