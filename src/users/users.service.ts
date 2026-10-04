import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { safeUserSelect } from '../auth/access';
import { CreateStaffDto } from '../auth/auth.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateStaffDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}
  list() {
    return this.prisma.user.findMany({
      where: { role: 'STAFF' },
      select: safeUserSelect,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }
  async create(input: CreateStaffDto) {
    return this.prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: await hash(input.password, 12),
        role: 'STAFF',
      },
      select: safeUserSelect,
    });
  }
  async update(id: string, input: UpdateStaffDto) {
    return this.prisma.user.update({
      where: { id, role: 'STAFF' },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.password !== undefined
          ? { passwordHash: await hash(input.password, 12) }
          : {}),
      },
      select: safeUserSelect,
    });
  }
}
