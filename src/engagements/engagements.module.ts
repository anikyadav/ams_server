import { Module } from '@nestjs/common';
import { EngagementsController } from './engagements.controller';
import { EngagementsService } from './engagements.service';
import { SubtasksModule } from '../subtasks/subtasks.module';

@Module({
  imports: [SubtasksModule],
  controllers: [EngagementsController],
  providers: [EngagementsService],
})
export class EngagementsModule {}
