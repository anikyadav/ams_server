import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { engagementVisibilityWhere, safeUserSelect } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCommentDto, UpdateCommentDto } from './comments.dto';

const relations = {
  author: { select: safeUserSelect },
} satisfies Prisma.CommentInclude;

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
  ) {}

  async listByEngagement(engagementId: string, actor: CurrentUser) {
    await this.assertViewable(engagementId, actor);
    return this.prisma.comment.findMany({
      where: { engagementId },
      include: relations,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  createOnEngagement(
    engagementId: string,
    input: CreateCommentDto,
    actor: CurrentUser,
  ) {
    return this.create(input, { engagementId }, actor);
  }

  async createOnSubTask(
    subTaskId: string,
    input: CreateCommentDto,
    actor: CurrentUser,
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: subTaskId, engagement: { fiscalYearId: this.fiscal.id } },
      select: { id: true, engagementId: true },
    });
    if (!subTask) throw new NotFoundException();
    await this.assertViewable(subTask.engagementId, actor);
    return this.create(
      input,
      { engagementId: subTask.engagementId, subTaskId },
      actor,
    );
  }

  private async create(
    input: CreateCommentDto,
    scope: { engagementId: string; subTaskId?: string },
    actor: CurrentUser,
  ) {
    await this.assertViewable(scope.engagementId, actor);
    return this.prisma.comment.create({
      data: {
        text: input.text,
        author: { connect: { id: actor.id } },
        engagement: { connect: { id: scope.engagementId } },
        subTask: scope.subTaskId
          ? { connect: { id: scope.subTaskId } }
          : undefined,
      },
      include: relations,
    });
  }

  async update(id: string, input: UpdateCommentDto, actor: CurrentUser) {
    const comment = await this.prisma.comment.findUnique({
      where: { id, engagement: { fiscalYearId: this.fiscal.id } },
      select: { authorId: true, engagementId: true },
    });
    if (!comment) throw new NotFoundException();
    await this.assertViewable(comment.engagementId, actor);
    if (comment.authorId !== actor.id)
      throw new ForbiddenException(
        'Only the comment author can edit this comment',
      );
    try {
      return await this.prisma.comment.update({
        where: {
          id,
          authorId: actor.id,
          engagement: {
            fiscalYearId: this.fiscal.id,
            ...engagementVisibilityWhere(actor),
          },
        },
        data: { text: input.text },
        include: relations,
      });
    } catch {
      throw new NotFoundException();
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.comment.delete({
        where: { id, engagement: { fiscalYearId: this.fiscal.id } },
      });
    } catch {
      throw new NotFoundException();
    }
  }

  private async assertViewable(engagementId: string, actor: CurrentUser) {
    const record = await this.prisma.engagement.findFirst({
      where: {
        id: engagementId,
        fiscalYearId: this.fiscal.id,
        ...engagementVisibilityWhere(actor),
      },
      select: { id: true },
    });
    if (!record)
      throw new ForbiddenException('Engagement is not viewable by this user');
  }
}
