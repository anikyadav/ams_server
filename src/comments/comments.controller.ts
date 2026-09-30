import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Roles } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { CreateCommentDto, UpdateCommentDto } from './comments.dto';
import { CommentsService } from './comments.service';

@ApiTags('Comments')
@ApiBearerAuth()
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('engagements/:id/comments')
  listByEngagement(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.comments.listByEngagement(id, actor);
  }

  @Post('engagements/:id/comments')
  createOnEngagement(
    @Param('id') id: string,
    @Body() body: CreateCommentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.comments.createOnEngagement(id, body, actor);
  }

  @Post('subtasks/:id/comments')
  createOnSubTask(
    @Param('id') id: string,
    @Body() body: CreateCommentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.comments.createOnSubTask(id, body, actor);
  }

  @Patch('comments/:id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateCommentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.comments.update(id, body, actor);
  }

  @Delete('comments/:id')
  @Roles('AUDITOR')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.comments.remove(id);
  }
}
