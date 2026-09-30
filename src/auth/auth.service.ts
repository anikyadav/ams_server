import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './auth.dto';

@Injectable()
export class AuthService {
  private readonly dummyHash = hash(randomBytes(32).toString('hex'), 12);
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}
  async login(input: LoginDto) {
    const account = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    const valid = await compare(
      input.password,
      account?.passwordHash ?? (await this.dummyHash),
    );
    if (!account || !valid || Buffer.byteLength(input.password, 'utf8') > 72)
      throw new UnauthorizedException('Invalid email or password');
    const { passwordHash: _passwordHash, ...user } = account;
    void _passwordHash;
    return {
      accessToken: await this.jwt.signAsync({ sub: user.id }),
      tokenType: 'Bearer',
      expiresIn: 3600,
      user,
    };
  }
}
