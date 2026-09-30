import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Actor, Roles } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { UpdateSubTaskDto } from './subtasks.dto';
import { SubtasksService } from './subtasks.service';

@ApiTags('Subtasks')
@ApiBearerAuth()
@Controller('subtasks')
export class SubtasksController {
  constructor(private readonly subtasks: SubtasksService) {}

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateSubTaskDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.subtasks.update(id, body, actor);
  }

  @Delete(':id')
  @Roles('AUDITOR')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Subtask deleted' })
  remove(@Param('id') id: string) {
    return this.subtasks.remove(id);
  }
}
