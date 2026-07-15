import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Search & Pagination')
@Controller('search/items')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search and filter workflow items with pagination',
  })
  @ApiQuery({ name: 'templateId', required: false, description: 'Filter by workflow type' })
  @ApiQuery({ name: 'stageId', required: false, description: 'Filter by current stage ID' })
  @ApiQuery({ name: 'stageName', required: false, description: 'Filter by current stage name (partial match)' })
  @ApiQuery({ name: 'assignedTo', required: false, description: 'Filter by assigned user ID' })
  @ApiQuery({ name: 'priority', required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @ApiQuery({ name: 'createdAfter', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'createdBefore', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'search', required: false, description: 'Text search on title' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'updatedAt', 'priority', 'title'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  search(
    @Query('templateId') templateId?: string,
    @Query('stageId') stageId?: string,
    @Query('stageName') stageName?: string,
    @Query('assignedTo') assignedUserId?: string,
    @Query('priority') priority?: string,
    @Query('createdAfter') createdAfter?: string,
    @Query('createdBefore') createdBefore?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.searchService.searchItems({
      templateId,
      stageId,
      stageName,
      assignedUserId,
      priority,
      createdAfter,
      createdBefore,
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      sortBy: sortBy as any,
      sortOrder: sortOrder as any,
    });
  }
}
