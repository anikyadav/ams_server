import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Roles } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { RevealDocumentDto, UpdateDocumentDto } from '../subtasks/document.dto';
import { IrdCredentialsService } from './ird-credentials.service';

@ApiTags('Client IRD credentials')
@ApiBearerAuth()
@Roles('AUDITOR')
@Controller('clients')
export class IrdCredentialsController {
  constructor(private readonly credentials: IrdCredentialsService) {}
  @Post('ird-credentials/export/challenge')
  @Header('Cache-Control', 'no-store')
  challengeExport(@Actor() actor: CurrentUser) {
    return this.credentials.exportChallenge(actor);
  }
  @Post('ird-credentials/export')
  @Header('Cache-Control', 'no-store')
  async export(@Body() body: RevealDocumentDto, @Actor() actor: CurrentUser) {
    return new StreamableFile(await this.credentials.export(body, actor), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="ird-credentials.xlsx"',
    });
  }
  @Get(':id/ird-credentials')
  @Header('Cache-Control', 'no-store')
  read(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.credentials.read(id, actor);
  }
  @Patch(':id/ird-credentials')
  @Header('Cache-Control', 'no-store')
  update(
    @Param('id') id: string,
    @Body() body: UpdateDocumentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.credentials.update(id, body, actor);
  }
  @Post(':id/ird-credentials/challenge')
  @Header('Cache-Control', 'no-store')
  challenge(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.credentials.challenge(id, actor);
  }
  @Post(':id/ird-credentials/reveal')
  @Header('Cache-Control', 'no-store')
  reveal(
    @Param('id') id: string,
    @Body() body: RevealDocumentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.credentials.reveal(id, body, actor);
  }
}
