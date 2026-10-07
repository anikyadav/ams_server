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
import {
  CreateDocumentRequestDto,
  UpdateDocumentRequestDto,
} from './requests.dto';
import { RequestsService } from './requests.service';

@ApiTags('Document requests')
@ApiBearerAuth()
@Controller()
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get('engagements/:id/requests')
  list(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.requests.list(id, actor);
  }

  @Post('engagements/:id/requests')
  @Roles('AUDITOR')
  create(
    @Param('id') id: string,
    @Body() body: CreateDocumentRequestDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.requests.create(id, body, actor);
  }

  @Patch('document-requests/:id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateDocumentRequestDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.requests.update(id, body, actor);
  }

  @Delete('document-requests/:id')
  @Roles('AUDITOR')
  @HttpCode(204)
  remove(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.requests.remove(id, actor);
  }
}
