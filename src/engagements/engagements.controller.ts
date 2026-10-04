import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Actor, Roles } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import {
  CreateEngagementDto,
  UpdateEngagementDto,
  UpdateEngagementProgressDto,
} from './engagements.dto';
import { CreateSubTaskDto } from '../subtasks/subtasks.dto';
import { EngagementsService } from './engagements.service';
import { SubtasksService } from '../subtasks/subtasks.service';

@ApiTags('Engagements')
@ApiBearerAuth()
@Controller('engagements')
export class EngagementsController {
  constructor(
    private readonly engagements: EngagementsService,
    private readonly subtasks: SubtasksService,
  ) {}

  @Get()
  @ApiOkResponse({ description: 'List engagements visible to the actor' })
  list(@Actor() actor: CurrentUser) {
    return this.engagements.list(actor);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Engagement detail with subtasks/comments' })
  findOne(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.engagements.findOne(id, actor);
  }

  @Post()
  @Roles('AUDITOR')
  @ApiCreatedResponse({ description: 'Engagement created' })
  create(@Body() body: CreateEngagementDto, @Actor() actor: CurrentUser) {
    return this.engagements.create(body, actor.id);
  }

  @Patch(':id/progress')
  @ApiOkResponse({ description: 'Update engagement milestone and discussion' })
  updateProgress(
    @Param('id') id: string,
    @Body() body: UpdateEngagementProgressDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.engagements.updateProgress(id, body, actor);
  }

  @Patch(':id')
  @Roles('AUDITOR')
  @ApiOkResponse({ description: 'Engagement updated' })
  update(
    @Param('id') id: string,
    @Body() body: UpdateEngagementDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.engagements.update(id, body, actor.id);
  }

  @Get(':id/activity')
  @ApiOkResponse({
    description: 'Change history of an engagement, newest first',
  })
  activity(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.engagements.activityFor(id, actor);
  }

  @Get(':id/subtasks')
  @ApiOkResponse({ description: 'Subtasks of an engagement visible to actor' })
  listSubTasks(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.subtasks.listByEngagement(id, actor);
  }

  @Post(':id/subtasks')
  @Roles('AUDITOR')
  @ApiCreatedResponse({ description: 'Subtask created on engagement' })
  createSubTask(
    @Param('id') id: string,
    @Body() body: CreateSubTaskDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.subtasks.create(id, body, actor.id);
  }

  @Delete(':id')
  @Roles('AUDITOR')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Engagement and its subtasks/comments deleted',
  })
  remove(@Param('id') id: string) {
    return this.engagements.remove(id);
  }
}
