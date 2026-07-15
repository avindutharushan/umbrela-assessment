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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ItemsService } from './items.service';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { TransitionItemDto } from './dto/transition-item.dto';
import { AddCommentDto } from './dto/add-comment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Workflow Items')
@Controller('items')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ItemsController {
  constructor(private itemsService: ItemsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new workflow item from a template' })
  create(@Body() dto: CreateItemDto, @CurrentUser('id') userId: string) {
    return this.itemsService.create(dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List workflow items with filtering and pagination' })
  @ApiQuery({ name: 'templateId', required: false })
  @ApiQuery({ name: 'stageId', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @Query('templateId') templateId?: string,
    @Query('stageId') stageId?: string,
    @Query('assignedTo') assignedUserId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.itemsService.findAll({
      templateId,
      stageId,
      assignedUserId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a workflow item with full details, audit trail, and available transitions' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.itemsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update item fields (requires version for optimistic locking)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateItemDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.itemsService.update(id, dto, userId);
  }

  @Post(':id/transitions')
  @ApiOperation({ summary: 'Transition an item to a new stage' })
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionItemDto,
    @CurrentUser() actor: any,
  ) {
    return this.itemsService.transition(id, dto, actor);
  }

  @Post(':id/assignments')
  @ApiOperation({ summary: 'Assign a user to this item' })
  addAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.itemsService.addAssignment(id, userId, actorId);
  }

  @Delete(':id/assignments/:userId')
  @ApiOperation({ summary: 'Remove a user assignment from this item' })
  removeAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.itemsService.removeAssignment(id, userId, actorId);
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Add a comment to this item' })
  addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.itemsService.addComment(id, dto, userId);
  }
}
