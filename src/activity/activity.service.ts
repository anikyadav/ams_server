import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { safeUserSelect } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

const withActor = { actor: { select: safeUserSelect } } as const;

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client so the entry commits atomically with the change. */
  record(
    db: Db,
    entry: {
      engagementId: string;
      actorId: string;
      action: string;
      summary: string;
      subTaskId?: string;
    },
  ) {
    return db.activityLog.create({ data: entry });
  }

  list(where: Prisma.ActivityLogWhereInput, take = 200) {
    return this.prisma.activityLog.findMany({
      where,
      include: {
        ...withActor,
        engagement: {
          select: {
            id: true,
            natureOfWork: true,
            client: { select: { name: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take,
    });
  }
}
