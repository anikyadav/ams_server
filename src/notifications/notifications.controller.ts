import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Actor } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOkResponse({ description: 'Latest notifications and the unread count' })
  list(@Actor() actor: CurrentUser) {
    return this.notifications.list(actor);
  }

  @Post('read-all')
  @HttpCode(204)
  readAll(@Actor() actor: CurrentUser) {
    return this.notifications.markAllRead(actor);
  }

  @Post(':id/read')
  @HttpCode(204)
  read(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.notifications.markRead(id, actor);
  }
}
