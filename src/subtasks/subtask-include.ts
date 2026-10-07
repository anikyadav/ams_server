import type { Prisma } from '../generated/prisma/client';
import { safeUserSelect } from '../auth/access';

/** Everything a client needs to render a task: people, sign-off trail and checklist. */
export const subTaskInclude = {
  assignedTo: { select: safeUserSelect },
  submittedBy: { select: safeUserSelect },
  reviewedBy: { select: safeUserSelect },
  checklist: {
    include: { doneBy: { select: safeUserSelect } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.SubTaskInclude;
