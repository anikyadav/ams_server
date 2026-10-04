import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Actor } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';

@ApiTags('Activity')
@ApiBearerAuth()
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
  ) {}

  /** The caller's own audit trail: what they did, plus changes to their tasks. */
  @Get('mine')
  @ApiOkResponse({
    description: 'Recent activity by or about the current user',
  })
  async mine(@Actor() actor: CurrentUser) {
    const myTasks = await this.prisma.subTask.findMany({
      where: {
        assignedToId: actor.id,
        engagement: { fiscalYearId: this.fiscal.id },
      },
      select: { id: true },
    });
    return this.activity.list(
      {
        engagement: { fiscalYearId: this.fiscal.id },
        OR: [
          { actorId: actor.id },
          { subTaskId: { in: myTasks.map((task) => task.id) } },
        ],
      },
      100,
    );
  }
}
