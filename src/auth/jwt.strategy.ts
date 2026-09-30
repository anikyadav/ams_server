import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { z } from 'zod';
import type { Environment } from '../config/environment';
import { PrismaService } from '../prisma/prisma.service';
import { safeUserSelect } from './access';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Environment, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
      algorithms: ['HS256'],
      issuer: 'audit-practice-api',
      audience: 'audit-practice-app',
      ignoreExpiration: false,
    });
  }
  async validate(payload: unknown) {
    const parsed = z
      .object({ sub: z.string().min(1), exp: z.number() })
      .safeParse(payload);
    if (!parsed.success) throw new UnauthorizedException();
    const user = await this.prisma.user.findUnique({
      where: { id: parsed.data.sub },
      select: safeUserSelect,
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
