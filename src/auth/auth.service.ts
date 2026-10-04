import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto, LoginDto } from './auth.dto';
import { LoginThrottle } from './login-throttle';

export const SESSION_SECONDS = 8 * 60 * 60;

@Injectable()
export class AuthService {
  private readonly dummyHash = hash(randomBytes(32).toString('hex'), 12);
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly throttle: LoginThrottle,
  ) {}
  async login(input: LoginDto, clientIp = 'unknown') {
    const throttleKey = `${clientIp}|${input.email}`;
    this.throttle.assertAllowed(throttleKey);
    const account = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    const valid = await compare(
      input.password,
      account?.passwordHash ?? (await this.dummyHash),
    );
    if (!account || !valid || Buffer.byteLength(input.password, 'utf8') > 72) {
      this.throttle.fail(throttleKey);
      throw new UnauthorizedException('Invalid email or password');
    }
    this.throttle.succeed(throttleKey);
    const { passwordHash: _passwordHash, ...user } = account;
    void _passwordHash;
    return {
      accessToken: await this.jwt.signAsync({ sub: user.id }),
      tokenType: 'Bearer',
      expiresIn: SESSION_SECONDS,
      user,
    };
  }

  async changePassword(userId: string, input: ChangePasswordDto) {
    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!(await compare(input.currentPassword, account.passwordHash)))
      throw new BadRequestException('Current password is incorrect');
    if (input.currentPassword === input.newPassword)
      throw new BadRequestException(
        'New password must differ from the current password',
      );
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hash(input.newPassword, 12) },
    });
  }
}
