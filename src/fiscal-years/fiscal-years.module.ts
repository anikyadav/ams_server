import { fiscalBoundaries } from './fiscal-year-boundaries';
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Roles } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class FiscalScope {
  constructor(@Inject(REQUEST) private readonly request: Request) {}
  get id(): string {
    const id = this.request.headers['x-fiscal-year-id'];
    if (typeof id !== 'string' || !id.trim())
      throw new BadRequestException('Select a fiscal year');
    return id;
  }
}

class CreateFiscalYearDto extends createZodDto(
  z.strictObject({
    startDate: z.iso.date(),
    endDate: z.iso.date(), // exclusive: next 1 Shrawan, converted to AD by the frontend
    copyFromId: z.string().min(1).optional(),
  }),
) {}

class AssignLegacyDto extends createZodDto(
  z.strictObject({ engagementId: z.string().min(1) }),
) {}

@Controller('fiscal-years')
export class FiscalYearsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.fiscalYear.findMany({ orderBy: { startDate: 'desc' } });
  }

  @Post(':id/assign-legacy')
  @Roles('AUDITOR')
  async assignLegacy(@Param('id') id: string, @Body() input: AssignLegacyDto) {
    if (id === 'legacy') throw new BadRequestException('Choose a fiscal year');
    return this.prisma.$transaction(async (tx) => {
      await tx.fiscalYear.findUniqueOrThrow({ where: { id } });
      const engagement = await tx.engagement.findUniqueOrThrow({
        where: { id: input.engagementId, fiscalYearId: 'legacy' },
        include: { client: true },
      });
      const client = await tx.client.upsert({
        where: {
          fiscalYearId_lineageId: {
            fiscalYearId: id,
            lineageId: engagement.client.lineageId,
          },
        },
        update: {},
        create: {
          fiscalYearId: id,
          lineageId: engagement.client.lineageId,
          name: engagement.client.name,
          pan: engagement.client.pan,
          fileLocation: engagement.client.fileLocation,
          location: engagement.client.location,
        },
      });
      // A conditional update prevents two reviewers assigning the same legacy record twice.
      return tx.engagement.update({
        where: { id: engagement.id, fiscalYearId: 'legacy' },
        data: { fiscalYearId: id, clientId: client.id },
      });
    });
  }

  @Post()
  @Roles('AUDITOR')
  async create(@Body() input: CreateFiscalYearDto) {
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    const index = fiscalBoundaries.findIndex(
      (date) => date === input.startDate,
    );
    if (index < 0 || fiscalBoundaries[index + 1] !== input.endDate) {
      throw new BadRequestException(
        'Fiscal year must use supported 1 Shrawan boundaries (AD dates)',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      if (input.copyFromId)
        await tx.fiscalYear.findUniqueOrThrow({
          where: { id: input.copyFromId },
        });
      const overlap = await tx.fiscalYear.findFirst({
        where: {
          startDate: { lt: endDate },
          endDate: { gt: startDate },
        },
      });
      if (overlap)
        throw new ConflictException(
          'This fiscal year already exists or overlaps an existing year',
        );
      const year = await tx.fiscalYear.create({ data: { startDate, endDate } });
      if (input.copyFromId) {
        const clients = await tx.client.findMany({
          where: { fiscalYearId: input.copyFromId },
        });
        await tx.client.createMany({
          data: clients.map((client) => ({
            name: client.name,
            pan: client.pan,
            fileLocation: client.fileLocation,
            location: client.location,
            lineageId: client.lineageId,
            fiscalYearId: year.id,
          })),
        });
      }
      return year;
    });
  }
}

@Global()
@Module({
  controllers: [FiscalYearsController],
  providers: [FiscalScope],
  exports: [FiscalScope],
})
export class FiscalYearsModule {}
