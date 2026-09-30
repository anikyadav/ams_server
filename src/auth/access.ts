import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: Date;
};
export const safeUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;
export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const Actor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUser =>
    context.switchToHttp().getRequest<Request & { user: CurrentUser }>().user,
);

export function engagementVisibilityWhere(
  actor: CurrentUser,
): Prisma.EngagementWhereInput {
  return actor.role === 'AUDITOR'
    ? {}
    : {
        OR: [
          { staffId: actor.id },
          { subTasks: { some: { assignedToId: actor.id } } },
        ],
      };
}
