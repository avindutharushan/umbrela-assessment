import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface SearchFilters {
  // Filter by workflow type (template)
  templateId?: string;
  
  // Filter by current stage
  stageId?: string;
  stageName?: string;
  
  // Filter by assigned user
  assignedUserId?: string;
  
  // Filter by priority
  priority?: string;
  
  // Filter by creation date range
  createdAfter?: string;
  createdBefore?: string;
  
  // Text search on title
  search?: string;
  
  // Pagination
  page?: number;
  limit?: number;
  
  // Sorting
  sortBy?: 'createdAt' | 'updatedAt' | 'priority' | 'title';
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  filters: Record<string, any>;
}

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  async searchItems(filters: SearchFilters): Promise<PaginatedResult<any>> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100); // Cap at 100
    const skip = (page - 1) * limit;

    // Build the WHERE clause dynamically
    const where: Prisma.WorkflowItemWhereInput = {};

    // Filter by template (workflow type)
    if (filters.templateId) {
      where.templateId = filters.templateId;
    }

    // Filter by current stage (ID or name)
    if (filters.stageId) {
      where.currentStageId = filters.stageId;
    }
    if (filters.stageName) {
      where.currentStage = { name: { contains: filters.stageName, mode: 'insensitive' } };
    }

    // Filter by assigned user
    if (filters.assignedUserId) {
      where.assignments = {
        some: { userId: filters.assignedUserId },
      };
    }

    // Filter by priority
    if (filters.priority) {
      // @ts-ignore Priority enum map
      where.priority = filters.priority as any;
    }

    // Filter by creation date range
    if (filters.createdAfter || filters.createdBefore) {
      where.createdAt = {};
      if (filters.createdAfter) {
        where.createdAt.gte = new Date(filters.createdAfter);
      }
      if (filters.createdBefore) {
        where.createdAt.lte = new Date(filters.createdBefore);
      }
    }

    // Text search on title
    if (filters.search) {
      where.title = { contains: filters.search, mode: 'insensitive' };
    }

    // Sorting
    const orderBy: Prisma.WorkflowItemOrderByWithRelationInput = {};
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'desc';
    orderBy[sortBy] = sortOrder;

    // Execute query with count
    const [items, total] = await Promise.all([
      this.prisma.workflowItem.findMany({
        where,
        include: {
          template: { select: { id: true, name: true } },
          currentStage: { select: { id: true, name: true, isFinal: true } },
          assignments: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
          _count: {
            select: { comments: true, attachments: true, auditEvents: true },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.workflowItem.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
      filters: {
        templateId: filters.templateId,
        stageId: filters.stageId,
        assignedUserId: filters.assignedUserId,
        priority: filters.priority,
        createdAfter: filters.createdAfter,
        createdBefore: filters.createdBefore,
        search: filters.search,
      },
    };
  }
}
