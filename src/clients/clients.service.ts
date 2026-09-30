import { FiscalScope } from '../fiscal-years/fiscal-years.module';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientDto, UpdateClientDto } from './clients.dto';

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalScope,
  ) {}

  list() {
    return this.prisma.client.findMany({
      where: { fiscalYearId: this.fiscal.id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  findOne(id: string) {
    return this.prisma.client.findUniqueOrThrow({
      where: { id, fiscalYearId: this.fiscal.id },
    });
  }

  create(input: CreateClientDto) {
    if (this.fiscal.id === 'legacy')
      throw new BadRequestException(
        'Select a fiscal year before creating new records',
      );
    return this.prisma.client.create({
      data: { ...input, fiscalYearId: this.fiscal.id },
    });
  }

  update(id: string, input: UpdateClientDto) {
    return this.prisma.client.update({
      where: { id, fiscalYearId: this.fiscal.id },
      data: input,
    });
  }

  async remove(id: string) {
    // The database RESTRICT constraint also protects concurrent assignments.
    // The shared Prisma filter maps related-record conflicts to HTTP 409.
    await this.prisma.client.delete({
      where: { id, fiscalYearId: this.fiscal.id },
    });
  }
}
