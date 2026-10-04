import { compare } from 'bcryptjs';
import { safeUserSelect } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';
import { updateStaffSchema } from './users.dto';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

describe('Staff account updates', () => {
  const update = jest
    .fn<Promise<{ id: string }>, [unknown]>()
    .mockResolvedValue({ id: 'staff' });
  const service = new UsersService({
    user: { update },
  } as unknown as PrismaService);

  beforeEach(() => update.mockClear());

  it('updates staff details without changing their password or role', async () => {
    await service.update('staff', {
      name: 'Updated',
      email: 'new@example.com',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'staff', role: 'STAFF' },
      data: { name: 'Updated', email: 'new@example.com' },
      select: safeUserSelect,
    });
  });

  it('hashes reset passwords and restricts the target to staff', async () => {
    const password = 'A-new-password-123';
    await service.update('staff', { password });
    const input = update.mock.calls[0][0] as {
      where: { id: string; role: string };
      data: { passwordHash: string };
    };
    expect(input.where).toEqual({ id: 'staff', role: 'STAFF' });
    expect(input.data.passwordHash).not.toBe(password);
    expect(await compare(password, input.data.passwordHash)).toBe(true);
  });

  it('validates credentials and rejects role changes and empty updates', () => {
    expect(updateStaffSchema.parse({ email: ' NEW@EXAMPLE.COM ' })).toEqual({
      email: 'new@example.com',
    });
    for (const invalid of [
      {},
      { role: 'AUDITOR' },
      { password: '' },
      { password: 'short' },
      { email: 'invalid' },
      { password: '😀'.repeat(20) },
    ]) {
      expect(updateStaffSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
