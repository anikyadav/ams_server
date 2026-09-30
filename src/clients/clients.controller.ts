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
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/access';
import { CreateClientDto, UpdateClientDto } from './clients.dto';
import { ClientsService } from './clients.service';

@ApiTags('Clients')
@ApiBearerAuth()
@Roles('AUDITOR')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list() {
    return this.clients.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.clients.findOne(id);
  }

  @Post()
  create(@Body() body: CreateClientDto) {
    return this.clients.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateClientDto) {
    return this.clients.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Client deleted' })
  remove(@Param('id') id: string) {
    return this.clients.remove(id);
  }
}
