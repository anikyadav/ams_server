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
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Actor, Roles } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import {
  CreateChecklistItemDto,
  ReviewSubTaskDto,
  UpdateChecklistItemDto,
  UpdateSubTaskDto,
} from './subtasks.dto';
import { SubtasksService } from './subtasks.service';

@ApiTags('Subtasks')
@ApiBearerAuth()
@Controller('subtasks')
export class SubtasksController {
  constructor(private readonly subtasks: SubtasksService) {}

  @Get(':id')
  findOne(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.subtasks.findOne(id, actor);
  }

  @Get(':id/activity')
  activity(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.subtasks.activityFor(id, actor);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateSubTaskDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.subtasks.update(id, body, actor);
  }

  @Post(':id/review')
  @Roles('AUDITOR')
  @ApiOkResponse({ description: 'Approve a submitted task or request changes' })
  review(
    @Param('id') id: string,
    @Body() body: ReviewSubTaskDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.subtasks.review(id, body, actor);
  }

  @Post(':id/checklist')
  @Roles('AUDITOR')
  @ApiOkResponse({ description: 'Add a checklist step; returns the task' })
  addChecklistItem(
    @Param('id') id: string,
    @Body() body: CreateChecklistItemDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.subtasks.addChecklistItem(id, body, actor);
  }

  @Delete(':id')
  @Roles('AUDITOR')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Subtask deleted' })
  remove(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.subtasks.remove(id, actor.id);
  }
}

@ApiTags('Subtasks')
@ApiBearerAuth()
@Controller('checklist-items')
export class ChecklistItemsController {
  constructor(private readonly subtasks: SubtasksService) {}

  @Patch(':id')
  @ApiOkResponse({
    description: 'Tick, untick or rename a step; returns the task',
  })
  update(
    @Param('id') id: string,
    @Body() body: UpdateChecklistItemDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.subtasks.updateChecklistItem(id, body, actor);
  }

  @Delete(':id')
  @Roles('AUDITOR')
  @ApiOkResponse({ description: 'Remove a step; returns the task' })
  remove(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.subtasks.removeChecklistItem(id, actor);
  }
}
