import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor } from '../auth/access';
import type { CurrentUser } from '../auth/access';
import { DocumentService } from './document.service';
import { RevealDocumentDto, UpdateDocumentDto } from './document.dto';

@ApiTags('Document')
@ApiBearerAuth()
@Controller('subtasks/:id/document')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.documents.read(id, actor);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  update(
    @Param('id') id: string,
    @Body() body: UpdateDocumentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.documents.update(id, body, actor);
  }

  @Post('challenge')
  @Header('Cache-Control', 'no-store')
  challenge(@Param('id') id: string, @Actor() actor: CurrentUser) {
    return this.documents.challenge(id, actor);
  }

  @Post('reveal')
  @Header('Cache-Control', 'no-store')
  reveal(
    @Param('id') id: string,
    @Body() body: RevealDocumentDto,
    @Actor() actor: CurrentUser,
  ) {
    return this.documents.reveal(id, body, actor);
  }
}
