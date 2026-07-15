import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Workflow Templates')
@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TemplatesController {
  constructor(private templatesService: TemplatesService) {}

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a new workflow template (admin only)' })
  create(@Body() dto: CreateTemplateDto, @CurrentUser('id') userId: string) {
    return this.templatesService.create(dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List all workflow templates' })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  findAll(@Query('active') active?: string) {
    const isActive = active === 'true' ? true : active === 'false' ? false : undefined;
    return this.templatesService.findAll({ isActive });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a template with full details (stages, transitions, permissions)' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templatesService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update template metadata (admin only)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.templatesService.update(id, dto, userId);
  }

  @Post(':id/stages')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Add a new stage to a template' })
  addStage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name: string; position?: number; isStart?: boolean; isFinal?: boolean },
  ) {
    return this.templatesService.addStage(id, body);
  }

  @Post(':id/transitions')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Add a new transition between stages' })
  addTransition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      fromStageId: string;
      toStageId: string;
      name?: string;
      permissions?: { role?: string; userId?: string }[];
    },
  ) {
    return this.templatesService.addTransition(id, body);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete a template (admin only)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.templatesService.remove(id);
  }
}
