import { Module } from '@nestjs/common';
import { EngagementsController } from './engagements.controller';
import { EngagementsService } from './engagements.service';
import { EngagementCloneService } from './engagement-clone.service';
import { SubtasksModule } from '../subtasks/subtasks.module';

@Module({
  imports: [SubtasksModule],
  controllers: [EngagementsController],
  providers: [EngagementsService, EngagementCloneService],
})
export class EngagementsModule {}
