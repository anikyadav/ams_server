import type { Prisma, EngagementStatus } from '../generated/prisma/client';

type TaskProgress = { status: string; progress: number };

export function completionFromTasks(tasks: TaskProgress[]) {
  const complete =
    tasks.length > 0 && tasks.every((task) => task.status === 'DONE');
  const progress = tasks.length
    ? Math.min(
        complete ? 100 : 99,
        Math.round(
          tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length,
        ),
      )
    : 0;
  return { complete, progress };
}

/** Serialize changes to activities/tasks so concurrent final ticks cannot miss completion. */
export async function lockEngagementWorkflow(
  tx: Prisma.TransactionClient,
  id: string,
) {
  // Updating the id to itself obtains the row lock without changing legacy progress.
  await tx.engagement.update({ where: { id }, data: { id } });
}

export async function syncEngagementCompletion(
  tx: Prisma.TransactionClient,
  id: string,
  actorId: string,
) {
  const engagement = await tx.engagement.findUniqueOrThrow({
    where: { id },
    include: { subTasks: { select: { status: true, progress: true } } },
  });
  const { complete } = completionFromTasks(engagement.subTasks);
  const status: EngagementStatus = complete
    ? engagement.status === 'DELIVERED'
      ? 'DELIVERED'
      : 'COMPLETE'
    : engagement.status === 'COMPLETE' || engagement.status === 'DELIVERED'
      ? engagement.subTasks.some((task) => task.progress > 0)
        ? 'IN_PROGRESS'
        : 'NOT_STARTED'
      : engagement.status === 'NOT_STARTED' &&
          engagement.subTasks.some((task) => task.progress > 0)
        ? 'IN_PROGRESS'
        : engagement.status;
  if (status === engagement.status) {
    if (engagement.subTasks.length && engagement.manualProgress !== null)
      await tx.engagement.update({
        where: { id },
        data: { manualProgress: null },
      });
    return;
  }
  await tx.engagement.update({
    where: { id },
    data: { status, manualProgress: null },
  });
  await tx.activityLog.create({
    data: {
      engagementId: id,
      actorId,
      action: complete
        ? 'ENGAGEMENT_COMPLETED'
        : engagement.status === 'COMPLETE' || engagement.status === 'DELIVERED'
          ? 'ENGAGEMENT_REOPENED'
          : 'ENGAGEMENT_UPDATED',
      summary: complete
        ? 'Completed engagement: all sub-tasks are complete.'
        : 'Engagement progress follows its sub-tasks; unfinished work remains.',
    },
  });
}
