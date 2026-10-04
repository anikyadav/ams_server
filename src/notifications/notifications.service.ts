import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CurrentUser } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

export type NotifyInput = {
  userIds: Array<string | null | undefined>;
  /** The person who caused the event; they are never notified about their own action. */
  actorId?: string;
  type: string;
  title: string;
  message: string;
  engagementId?: string;
  subTaskId?: string;
  dedupeKey?: string;
};

const SWEEP_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

function nepalToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

@Injectable()
export class NotificationsService {
  private readonly lastSweep = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async notify(db: Db, input: NotifyInput) {
    const userIds = [...new Set(input.userIds)].filter(
      (id): id is string => !!id && id !== input.actorId,
    );
    if (!userIds.length) return;
    await db.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: input.type,
        title: input.title,
        message: input.message,
        engagementId: input.engagementId,
        subTaskId: input.subTaskId,
        dedupeKey: input.dedupeKey,
      })),
      skipDuplicates: true,
    });
  }

  async auditorIds(db: Db = this.prisma) {
    const auditors = await db.user.findMany({
      where: { role: 'AUDITOR' },
      select: { id: true },
    });
    return auditors.map((user) => user.id);
  }

  async list(actor: CurrentUser) {
    await this.sweepDeadlines(actor);
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: actor.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 50,
      }),
      this.prisma.notification.count({
        where: { userId: actor.id, readAt: null },
      }),
    ]);
    return { items, unreadCount };
  }

  async markRead(id: string, actor: CurrentUser) {
    await this.prisma.notification.updateMany({
      where: { id, userId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(actor: CurrentUser) {
    await this.prisma.notification.updateMany({
      where: { userId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /**
   * Creates due-soon / overdue reminders on demand (no scheduler needed). Each
   * reminder is deduplicated per item, date and kind, so repeated sweeps are safe.
   */
  private async sweepDeadlines(actor: CurrentUser) {
    const nowMs = Date.now();
    if (nowMs - (this.lastSweep.get(actor.id) ?? 0) < SWEEP_INTERVAL_MS) return;
    this.lastSweep.set(actor.id, nowMs);

    const today = new Date(`${nepalToday()}T00:00:00Z`);
    const from = new Date(today.getTime() - 30 * DAY_MS);
    const until = new Date(today.getTime() + 3 * DAY_MS); // exclusive: today + 2 days
    const dueRange = { gte: from, lt: until };
    const label = (due: Date) => {
      const days = Math.round((due.getTime() - today.getTime()) / DAY_MS);
      return days < 0
        ? {
            overdue: true,
            text: `${-days} day${days === -1 ? '' : 's'} overdue`,
          }
        : {
            overdue: false,
            text:
              days === 0
                ? 'due today'
                : `due in ${days} day${days === 1 ? '' : 's'}`,
          };
    };
    const engagementOpen = { notIn: ['COMPLETE', 'DELIVERED'] as const };

    const engagements = await this.prisma.engagement.findMany({
      where: {
        targetDate: dueRange,
        status: { notIn: [...engagementOpen.notIn] },
        ...(actor.role === 'AUDITOR' ? {} : { staffId: actor.id }),
      },
      select: {
        id: true,
        natureOfWork: true,
        targetDate: true,
        client: { select: { name: true } },
      },
    });
    for (const item of engagements) {
      const due = new Date(item.targetDate!.toISOString().slice(0, 10));
      const state = label(due);
      await this.notify(this.prisma, {
        userIds: [actor.id],
        type: state.overdue ? 'ENGAGEMENT_OVERDUE' : 'ENGAGEMENT_DUE',
        title: state.overdue
          ? 'Engagement overdue'
          : 'Engagement deadline approaching',
        message: `${item.client.name} — ${item.natureOfWork} is ${state.text}.`,
        engagementId: item.id,
        dedupeKey: `eng:${item.id}:${due.toISOString().slice(0, 10)}:${state.overdue ? 'over' : 'soon'}`,
      });
    }

    if (actor.role !== 'STAFF') return;
    const tasks = await this.prisma.subTask.findMany({
      where: {
        assignedToId: actor.id,
        dueDate: dueRange,
        status: { not: 'DONE' },
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        engagementId: true,
        engagement: { select: { client: { select: { name: true } } } },
      },
    });
    for (const task of tasks) {
      const due = task.dueDate!;
      const state = label(due);
      await this.notify(this.prisma, {
        userIds: [actor.id],
        type: state.overdue ? 'TASK_OVERDUE' : 'TASK_DUE',
        title: state.overdue ? 'Task overdue' : 'Task deadline approaching',
        message: `"${task.title}" (${task.engagement.client.name}) is ${state.text}.`,
        engagementId: task.engagementId,
        subTaskId: task.id,
        dedupeKey: `task:${task.id}:${due.toISOString().slice(0, 10)}:${state.overdue ? 'over' : 'soon'}`,
      });
    }
  }
}
