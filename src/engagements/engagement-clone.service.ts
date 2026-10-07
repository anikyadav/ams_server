import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import { defaultEngagementTasks } from './default-tasks';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { CurrentUser } from '../auth/access';

const DAY = 86_400_000;

type Skipped = { sourceId: string; label: string; reason: string };
type Created = { id: string; clientName: string; natureOfWork: string };

/**
 * Starts this year's engagements from last year's: same client, lead, tasks,
 * steps and document requests, with everything reset and dates moved forward by
 * the gap between the two fiscal years.
 */
@Injectable()
export class EngagementCloneService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  async clone(sourceIds: string[], actor: CurrentUser) {
    if (this.fiscal.id === 'legacy')
      throw new BadRequestException(
        'Select a fiscal year before creating new records',
      );
    const targetYear = await this.prisma.fiscalYear.findUniqueOrThrow({
      where: { id: this.fiscal.id },
    });
    const unique = [...new Set(sourceIds)];
    const sources = await this.prisma.engagement.findMany({
      where: { id: { in: unique } },
      include: {
        client: true,
        fiscalYear: true,
        staff: { select: { role: true } },
        subTasks: {
          include: { checklist: true, assignedTo: { select: { role: true } } },
        },
        documentRequests: true,
      },
    });
    const created: Created[] = [];
    const skipped: Skipped[] = [];

    for (const sourceId of unique) {
      const source = sources.find((item) => item.id === sourceId);
      if (!source) {
        skipped.push({ sourceId, label: sourceId, reason: 'Not found' });
        continue;
      }
      const label = `${source.client.name} — ${source.natureOfWork}`;
      const skip = (reason: string) =>
        skipped.push({ sourceId, label, reason });
      if (source.fiscalYearId === targetYear.id)
        skip('Already belongs to this fiscal year');
      else if (source.fiscalYearId === 'legacy')
        skip('Legacy engagements have no fiscal year to copy from');
      else if (source.staff.role !== 'STAFF')
        skip('The lead is no longer a staff member');
      else if (source.subTasks.some((task) => task.assignedTo.role !== 'STAFF'))
        skip('A task is assigned to someone who is no longer staff');
      else {
        const client = await this.prisma.client.findUnique({
          where: {
            fiscalYearId_lineageId: {
              fiscalYearId: targetYear.id,
              lineageId: source.client.lineageId,
            },
          },
        });
        if (!client) {
          skip('The client was not carried into this fiscal year');
          continue;
        }
        const duplicate = await this.prisma.engagement.findFirst({
          where: {
            fiscalYearId: targetYear.id,
            clientId: client.id,
            natureOfWork: source.natureOfWork,
          },
          select: { id: true },
        });
        if (duplicate) {
          skip('Already exists in this fiscal year');
          continue;
        }
        const gapDays =
          source.fiscalYear.startDate && targetYear.startDate
            ? Math.round(
                (targetYear.startDate.getTime() -
                  source.fiscalYear.startDate.getTime()) /
                  DAY,
              )
            : null;
        const shift = (date: Date | null) =>
          date && gapDays !== null
            ? new Date(date.getTime() + gapDays * DAY)
            : null;
        const have = new Set(source.subTasks.map((task) => task.templateKey));
        const missingRequired = defaultEngagementTasks(source.staffId).filter(
          (task) => !have.has(task.templateKey),
        );
        const made = await this.prisma.$transaction(
          async (tx) => {
            const engagement = await tx.engagement.create({
              data: {
                fiscalYear: { connect: { id: targetYear.id } },
                client: {
                  connect: {
                    id_fiscalYearId: {
                      id: client.id,
                      fiscalYearId: targetYear.id,
                    },
                  },
                },
                staff: { connect: { id: source.staffId } },
                natureOfWork: source.natureOfWork,
                priority: source.priority,
                status: 'NOT_STARTED',
                startDate: shift(source.startDate),
                targetDate: shift(source.targetDate),
                subTasks: {
                  create: [
                    ...source.subTasks.map((task) => ({
                      templateKey: task.templateKey,
                      sortOrder: task.sortOrder,
                      title: task.title,
                      description: task.description,
                      priority: task.priority,
                      dueDate: shift(task.dueDate),
                      assignedToId: task.assignedToId,
                      checklist: {
                        create: task.checklist.map((item) => ({
                          text: item.text,
                          sortOrder: item.sortOrder,
                        })),
                      },
                    })),
                    ...missingRequired,
                  ],
                },
                documentRequests: {
                  create: source.documentRequests.map((request) => ({
                    title: request.title,
                    description: request.description,
                    dueDate: shift(request.dueDate),
                    createdById: actor.id,
                  })),
                },
              },
              include: { subTasks: { select: { assignedToId: true } } },
            });
            await this.activity.record(tx, {
              engagementId: engagement.id,
              actorId: actor.id,
              action: 'ENGAGEMENT_CREATED',
              summary: `Created engagement "${engagement.natureOfWork}" for ${client.name} by copying the previous year's engagement (${source.subTasks.length} tasks).`,
            });
            await this.notifications.notify(tx, {
              userIds: [
                engagement.staffId,
                ...engagement.subTasks.map((task) => task.assignedToId),
              ],
              actorId: actor.id,
              type: 'ENGAGEMENT_ASSIGNED',
              title: 'New engagement assigned',
              message: `${client.name} — ${engagement.natureOfWork}`,
              engagementId: engagement.id,
            });
            return engagement;
          },
          { timeout: 15_000 },
        );
        created.push({
          id: made.id,
          clientName: client.name,
          natureOfWork: made.natureOfWork,
        });
      }
    }
    return { created, skipped };
  }
}
