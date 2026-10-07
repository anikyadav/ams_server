import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { FiscalScope } from '../fiscal-years/fiscal-years.module';
import type { CurrentUser } from '../auth/access';
import { IrdCredentialsService } from './ird-credentials.service';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('IRD credential access guards', () => {
  const actor: CurrentUser = {
    id: 'staff',
    name: 'Staff',
    email: 'staff@test.example',
    role: 'STAFF',
    createdAt: new Date(),
  };
  const findFirst = jest.fn();
  const findUnique = jest.fn();
  const log = jest.fn();
  const prisma = {
    client: { findFirst },
    clientIrdCredential: { findUnique },
    irdCredentialAccessLog: { create: log },
  } as unknown as PrismaService;
  const fiscal = { id: 'year-one' } as FiscalScope;
  const config = new ConfigService({
    IRD_CREDENTIAL_ENCRYPTION_KEY: 'ab'.repeat(32),
  });
  const service = new IrdCredentialsService(prisma, fiscal, config);

  beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue({ id: 'client' });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects expired calculations before reading a password or logging a reveal', async () => {
    const start = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(start);
    const challenge = await service.challenge('client', actor);
    const answer = challenge.question
      .split(' + ')
      .map(Number)
      .reduce((a, b) => a + b, 0);
    jest.spyOn(Date, 'now').mockReturnValue(start + 120001);
    await expect(
      service.reveal('client', { token: challenge.token, answer }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects a reveal challenge used for an export', async () => {
    const auditor = { ...actor, role: 'AUDITOR' as const };
    const challenge = await service.challenge('client', auditor);
    const answer = challenge.question
      .split(' + ')
      .map(Number)
      .reduce((a, b) => a + b, 0);
    await expect(
      service.export({ token: challenge.token, answer }, auditor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks assignment for every reveal and forbids staff exports at the service boundary', async () => {
    const challenge = await service.challenge('client', actor);
    findFirst.mockResolvedValue(null);
    await expect(
      service.reveal('client', { token: challenge.token, answer: 7 }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(() => service.exportChallenge(actor)).toThrow(ForbiddenException);
    await expect(
      service.export({ token: challenge.token, answer: 7 }, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
