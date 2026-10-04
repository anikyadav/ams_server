import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, Public } from './access';
import type { CurrentUser } from './access';
import { ChangePasswordDto, LoginDto } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto, @Req() request: Request) {
    return this.auth.login(body, request.ip);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(204)
  changePassword(@Actor() user: CurrentUser, @Body() body: ChangePasswordDto) {
    return this.auth.changePassword(user.id, body);
  }
  @ApiBearerAuth()
  @Get('me')
  me(@Actor() user: CurrentUser) {
    return user;
  }
}
