import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { IrdCredentialsService } from './ird-credentials.service';
import { IrdCredentialsController } from './ird-credentials.controller';

@Module({
  controllers: [ClientsController, IrdCredentialsController],
  providers: [ClientsService, IrdCredentialsService],
  exports: [IrdCredentialsService],
})
export class ClientsModule {}
