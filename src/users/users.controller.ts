import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/access';
import { CreateStaffDto } from '../auth/auth.dto';
import { UsersService } from './users.service';

@ApiTags('Staff')
@ApiBearerAuth()
@Roles('AUDITOR')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get()
  list() {
    return this.users.list();
  }
  @Post()
  create(@Body() body: CreateStaffDto) {
    return this.users.create(body);
  }
}
