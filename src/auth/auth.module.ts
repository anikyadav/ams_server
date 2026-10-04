import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { Environment } from '../config/environment';
import { AuthController } from './auth.controller';
import { AuthService, SESSION_SECONDS } from './auth.service';
import { LoginThrottle } from './login-throttle';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard, RolesGuard } from './auth.guards';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: SESSION_SECONDS,
          issuer: 'audit-practice-api',
          audience: 'audit-practice-app',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginThrottle,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
