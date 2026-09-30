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
import { CreateSubTaskDto, UpdateSubTaskDto } from './subtasks.dto';

const relations = {
  assignedTo: { select: safeUserSelect },
} satisfies Prisma.SubTaskInclude;

const visibleWhere = (actor: CurrentUser): Prisma.SubTaskWhereInput =>
  actor.role === 'AUDITOR' ? {} : { assignedToId: actor.id };

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
  ) {}

  async create(engagementId: string, input: CreateSubTaskDto) {
    await this.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId, fiscalYearId: this.fiscal.id },
    });
    await this.assertAssigneeIsStaff(input.assignedToId);
    return this.prisma.subTask.create({
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
      assignedToId: input.assignedToId,
    };
  }

  async remove(id: string) {
    try {
      await this.prisma.subTask.delete({
        where: { id, engagement: { fiscalYearId: this.fiscal.id } },
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
