import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/access';
import { CreateStaffDto } from '../auth/auth.dto';
import { UsersService } from './users.service';
import { UpdateStaffDto } from './users.dto';

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
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateStaffDto) {
    return this.users.update(id, body);
  }
}
