import { Module } from '@nestjs/common';
import {
  ChecklistItemsController,
  SubtasksController,
} from './subtasks.controller';
import { SubtasksService } from './subtasks.service';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { ClientsModule } from '../clients/clients.module';

@Module({
  imports: [ClientsModule],
  controllers: [
    SubtasksController,
    ChecklistItemsController,
    DocumentController,
  ],
  providers: [SubtasksService, DocumentService],
  exports: [SubtasksService],
})
export class SubtasksModule {}
