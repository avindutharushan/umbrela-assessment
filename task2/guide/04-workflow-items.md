# Guide 04 — Workflow Items

> **What you'll build in this guide:** CRUD operations for workflow items — creating items from a template, assigning users, moving items through stages (with audit events), and recording comments. This is Requirement 2 of the assessment.

---

## 1. What the Assessment Requires

> *"Create items from a template, assign one or more users, move items through valid stages, record comments, and manage document attachments."*

Key design note: Every operation that modifies a workflow item **must** generate an immutable audit event. The `workflow_items` table stores *materialized/cached* state, but `audit_events` is the source of truth.

---

## 2. DTOs

```typescript
// src/items/dto/create-item.dto.ts
import { IsString, IsOptional, IsUUID, IsArray, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum Priority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export class CreateItemDto {
  @ApiProperty({ description: 'The template to create this item from' })
  @IsUUID()
  templateId: string;

  @ApiProperty({ example: 'Fix login bug on mobile' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 'Users report being unable to login on iOS Safari' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: Priority, default: Priority.MEDIUM })
  @IsEnum(Priority)
  @IsOptional()
  priority?: Priority;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'User IDs to assign to this item', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  assigneeIds?: string[];
}
```

```typescript
// src/items/dto/update-item.dto.ts
import { IsString, IsOptional, IsEnum, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Priority } from './create-item.dto';

export class UpdateItemDto {
  @ApiPropertyOptional({ example: 'Updated title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: Priority })
  @IsEnum(Priority)
  @IsOptional()
  priority?: Priority;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'Current version for optimistic locking' })
  version: number; // REQUIRED for concurrency safety — see Guide 07
}
```

```typescript
// src/items/dto/transition-item.dto.ts
import { IsUUID, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransitionItemDto {
  @ApiProperty({ description: 'Target stage ID to transition to' })
  @IsUUID()
  toStageId: string;

  @ApiProperty({ description: 'Current version for optimistic locking' })
  @IsInt()
  version: number;
}
```

```typescript
// src/items/dto/add-comment.dto.ts
import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddCommentDto {
  @ApiProperty({ example: 'This needs to be reviewed by the security team.' })
  @IsString()
  @MinLength(1)
  body: string;
}
```

---

## 3. Audit Service (used by Items Service)

This service is the core of event sourcing. Every operation goes through it.

```typescript
// src/audit/audit.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export enum AuditEventType {
  ITEM_CREATED = 'ITEM_CREATED',
  STAGE_TRANSITION = 'STAGE_TRANSITION',
  FIELD_UPDATED = 'FIELD_UPDATED',
  ASSIGNMENT_ADDED = 'ASSIGNMENT_ADDED',
  ASSIGNMENT_REMOVED = 'ASSIGNMENT_REMOVED',
  COMMENT_ADDED = 'COMMENT_ADDED',
  ATTACHMENT_ADDED = 'ATTACHMENT_ADDED',
  ATTACHMENT_REMOVED = 'ATTACHMENT_REMOVED',
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /**
   * Record an audit event. This is the ONLY way state changes should be persisted.
   * 
   * The caller passes a Prisma transaction client so that the audit event and
   * the materialized state update happen in the SAME transaction — ensuring
   * atomicity (same pattern as Task 1's ledger_entries + orders.status).
   */
  async recordEvent(
    tx: Prisma.TransactionClient,
    data: {
      itemId: string;
      actorId: string;
      eventType: AuditEventType;
      payload: Record<string, any>;
    },
  ) {
    // Get the next sequence number for this item
    const lastEvent = await tx.auditEvent.findFirst({
      where: { itemId: data.itemId },
      orderBy: { sequenceNum: 'desc' },
      select: { sequenceNum: true },
    });

    const sequenceNum = (lastEvent?.sequenceNum ?? 0) + 1;

    return tx.auditEvent.create({
      data: {
        itemId: data.itemId,
        actorId: data.actorId,
        eventType: data.eventType,
        payload: data.payload,
        sequenceNum,
      },
    });
  }

  /**
   * Get all events for a workflow item, ordered by sequence number.
   * Used for audit display and state reconstruction (Guide 08).
   */
  async getEventsByItemId(itemId: string) {
    return this.prisma.auditEvent.findMany({
      where: { itemId },
      orderBy: { sequenceNum: 'asc' },
      include: {
        actor: { select: { id: true, name: true, email: true } },
      },
    });
  }
}
```

```typescript
// src/audit/audit.module.ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

---

## 4. Notification Service Stub (used by Items Service)

We'll flesh this out fully in Guide 10. For now, a stub that queues notifications to the database.

```typescript
// src/notifications/notifications.service.ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class NotificationsService {
  /**
   * Queue a notification for later processing.
   * Uses the same transaction as the operation that triggers it —
   * so if the operation fails, the notification is also rolled back.
   */
  async queue(
    tx: Prisma.TransactionClient,
    data: {
      userId: string;
      type: string;
      payload: Record<string, any>;
    },
  ) {
    return tx.notificationOutbox.create({
      data: {
        userId: data.userId,
        type: data.type,
        payload: data.payload,
        status: 'PENDING',
      },
    });
  }

  /**
   * Queue notifications for multiple users.
   */
  async queueForMany(
    tx: Prisma.TransactionClient,
    userIds: string[],
    type: string,
    payload: Record<string, any>,
  ) {
    return Promise.all(
      userIds.map((userId) => this.queue(tx, { userId, type, payload })),
    );
  }
}
```

```typescript
// src/notifications/notifications.module.ts
import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

---

## 5. Items Service

This is the main service — every operation is wrapped in a transaction that atomically:
1. Updates the materialized state (`workflow_items`)
2. Appends an audit event (`audit_events`)
3. Queues notifications (`notification_outbox`)

```typescript
// src/items/items.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, AuditEventType } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { TransitionItemDto } from './dto/transition-item.dto';
import { AddCommentDto } from './dto/add-comment.dto';

@Injectable()
export class ItemsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Create a new workflow item from a template.
   * 
   * The item starts at the template's start stage.
   * An ITEM_CREATED audit event is recorded.
   */
  async create(dto: CreateItemDto, actorId: string) {
    // Fetch the template with its start stage
    const template = await this.prisma.workflowTemplate.findUnique({
      where: { id: dto.templateId },
      include: {
        stages: { where: { isStart: true } },
      },
    });

    if (!template) {
      throw new NotFoundException(`Template ${dto.templateId} not found`);
    }

    if (!template.isActive) {
      throw new BadRequestException('Cannot create items from an inactive template');
    }

    if (template.stages.length === 0) {
      throw new BadRequestException('Template has no start stage defined');
    }

    const startStage = template.stages[0];

    return this.prisma.$transaction(async (tx) => {
      // 1. Create the workflow item (materialized state)
      const item = await tx.workflowItem.create({
        data: {
          templateId: dto.templateId,
          title: dto.title,
          description: dto.description,
          priority: dto.priority || 'MEDIUM',
          currentStageId: startStage.id,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        },
      });

      // 2. Record ITEM_CREATED audit event
      await this.auditService.recordEvent(tx, {
        itemId: item.id,
        actorId,
        eventType: AuditEventType.ITEM_CREATED,
        payload: {
          templateId: dto.templateId,
          templateName: template.name,
          title: dto.title,
          description: dto.description,
          priority: dto.priority || 'MEDIUM',
          startStageId: startStage.id,
          startStageName: startStage.name,
          dueDate: dto.dueDate || null,
        },
      });

      // 3. Handle assignments
      if (dto.assigneeIds && dto.assigneeIds.length > 0) {
        for (const userId of dto.assigneeIds) {
          await tx.workflowItemAssignment.create({
            data: { itemId: item.id, userId },
          });

          await this.auditService.recordEvent(tx, {
            itemId: item.id,
            actorId,
            eventType: AuditEventType.ASSIGNMENT_ADDED,
            payload: { userId },
          });

          // Queue notification for assigned user
          await this.notificationsService.queue(tx, {
            userId,
            type: 'ASSIGNMENT',
            payload: {
              itemId: item.id,
              itemTitle: dto.title,
              assignedBy: actorId,
            },
          });
        }
      }

      // Return the full item
      return this.findOneRaw(tx, item.id);
    });
  }

  /**
   * Transition a workflow item to a new stage.
   * 
   * This is the core operation. It:
   * 1. Validates the transition exists in the template
   * 2. Checks version for optimistic concurrency (Guide 07)
   * 3. Updates the materialized state
   * 4. Records a STAGE_TRANSITION audit event
   * 5. Queues notifications for assigned users
   */
  async transition(itemId: string, dto: TransitionItemDto, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Fetch the item with a row-level lock (SELECT ... FOR UPDATE)
      // This prevents race conditions at the DB level
      const items = await tx.$queryRaw<any[]>`
        SELECT * FROM workflow_items WHERE id = ${itemId}::uuid FOR UPDATE
      `;

      if (items.length === 0) {
        throw new NotFoundException(`Workflow item ${itemId} not found`);
      }

      const item = items[0];

      // Optimistic concurrency check
      if (item.version !== dto.version) {
        throw new ConflictException({
          message: 'Version conflict — this item has been modified by another user',
          currentVersion: item.version,
          yourVersion: dto.version,
        });
      }

      // Validate the transition exists in the template
      const transition = await tx.stageTransition.findUnique({
        where: {
          fromStageId_toStageId: {
            fromStageId: item.current_stage_id,
            toStageId: dto.toStageId,
          },
        },
        include: {
          fromStage: { select: { id: true, name: true } },
          toStage: { select: { id: true, name: true } },
          permissions: true,
        },
      });

      if (!transition) {
        throw new BadRequestException(
          `Invalid transition: no path from current stage to target stage`,
        );
      }

      // Permission check (detailed in Guide 05)
      await this.checkTransitionPermission(transition, actorId);

      // Update materialized state
      await tx.workflowItem.update({
        where: { id: itemId },
        data: {
          currentStageId: dto.toStageId,
          version: { increment: 1 }, // Bump version for optimistic locking
        },
      });

      // Record audit event
      await this.auditService.recordEvent(tx, {
        itemId,
        actorId,
        eventType: AuditEventType.STAGE_TRANSITION,
        payload: {
          fromStageId: transition.fromStage.id,
          fromStageName: transition.fromStage.name,
          toStageId: transition.toStage.id,
          toStageName: transition.toStage.name,
          transitionName: transition.name,
        },
      });

      // Queue notifications for all assigned users
      const assignments = await tx.workflowItemAssignment.findMany({
        where: { itemId },
        select: { userId: true },
      });

      const notifyUserIds = assignments
        .map((a) => a.userId)
        .filter((id) => id !== actorId); // Don't notify the actor

      if (notifyUserIds.length > 0) {
        await this.notificationsService.queueForMany(
          tx,
          notifyUserIds,
          'STAGE_TRANSITION',
          {
            itemId,
            fromStage: transition.fromStage.name,
            toStage: transition.toStage.name,
            transitionedBy: actorId,
          },
        );
      }

      return this.findOneRaw(tx, itemId);
    });
  }

  /**
   * Update a workflow item's fields (title, description, priority, dueDate).
   * Uses optimistic concurrency — the client must send the current version.
   */
  async update(itemId: string, dto: UpdateItemDto, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Fetch with row lock
      const items = await tx.$queryRaw<any[]>`
        SELECT * FROM workflow_items WHERE id = ${itemId}::uuid FOR UPDATE
      `;

      if (items.length === 0) {
        throw new NotFoundException(`Workflow item ${itemId} not found`);
      }

      const item = items[0];

      // Optimistic concurrency check
      if (item.version !== dto.version) {
        throw new ConflictException({
          message: 'Version conflict — this item has been modified by another user',
          currentVersion: item.version,
          yourVersion: dto.version,
        });
      }

      // Build the update data and track changes for audit
      const changes: Record<string, { old: any; new: any }> = {};
      const updateData: Record<string, any> = {
        version: { increment: 1 },
      };

      if (dto.title !== undefined && dto.title !== item.title) {
        changes.title = { old: item.title, new: dto.title };
        updateData.title = dto.title;
      }

      if (dto.description !== undefined && dto.description !== item.description) {
        changes.description = { old: item.description, new: dto.description };
        updateData.description = dto.description;
      }

      if (dto.priority !== undefined && dto.priority !== item.priority) {
        changes.priority = { old: item.priority, new: dto.priority };
        updateData.priority = dto.priority;
      }

      if (dto.dueDate !== undefined) {
        const newDate = new Date(dto.dueDate);
        changes.dueDate = { old: item.due_date, new: newDate };
        updateData.dueDate = newDate;
      }

      if (Object.keys(changes).length === 0) {
        throw new BadRequestException('No changes detected');
      }

      // Update materialized state
      await tx.workflowItem.update({
        where: { id: itemId },
        data: updateData,
      });

      // Record audit event for each changed field
      for (const [field, { old: oldValue, new: newValue }] of Object.entries(changes)) {
        await this.auditService.recordEvent(tx, {
          itemId,
          actorId,
          eventType: AuditEventType.FIELD_UPDATED,
          payload: { field, oldValue, newValue },
        });
      }

      return this.findOneRaw(tx, itemId);
    });
  }

  /**
   * Assign a user to a workflow item.
   */
  async addAssignment(itemId: string, userId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.workflowItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundException(`Workflow item ${itemId} not found`);

      // Check if already assigned
      const existing = await tx.workflowItemAssignment.findUnique({
        where: { itemId_userId: { itemId, userId } },
      });
      if (existing) {
        throw new BadRequestException('User is already assigned to this item');
      }

      await tx.workflowItemAssignment.create({
        data: { itemId, userId },
      });

      // Audit event
      await this.auditService.recordEvent(tx, {
        itemId,
        actorId,
        eventType: AuditEventType.ASSIGNMENT_ADDED,
        payload: { userId },
      });

      // Notify the assigned user
      await this.notificationsService.queue(tx, {
        userId,
        type: 'ASSIGNMENT',
        payload: { itemId, itemTitle: item.title, assignedBy: actorId },
      });

      return this.findOneRaw(tx, itemId);
    });
  }

  /**
   * Remove a user assignment from a workflow item.
   */
  async removeAssignment(itemId: string, userId: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.workflowItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundException(`Workflow item ${itemId} not found`);

      const assignment = await tx.workflowItemAssignment.findUnique({
        where: { itemId_userId: { itemId, userId } },
      });
      if (!assignment) {
        throw new BadRequestException('User is not assigned to this item');
      }

      await tx.workflowItemAssignment.delete({
        where: { id: assignment.id },
      });

      await this.auditService.recordEvent(tx, {
        itemId,
        actorId,
        eventType: AuditEventType.ASSIGNMENT_REMOVED,
        payload: { userId },
      });

      return this.findOneRaw(tx, itemId);
    });
  }

  /**
   * Add a comment to a workflow item.
   */
  async addComment(itemId: string, dto: AddCommentDto, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.workflowItem.findUnique({ where: { id: itemId } });
      if (!item) throw new NotFoundException(`Workflow item ${itemId} not found`);

      const comment = await tx.workflowItemComment.create({
        data: {
          itemId,
          authorId: actorId,
          body: dto.body,
        },
      });

      // Audit event
      await this.auditService.recordEvent(tx, {
        itemId,
        actorId,
        eventType: AuditEventType.COMMENT_ADDED,
        payload: { commentId: comment.id, body: dto.body },
      });

      // Notify all assigned users (except commenter)
      const assignments = await tx.workflowItemAssignment.findMany({
        where: { itemId },
        select: { userId: true },
      });

      const notifyUserIds = assignments
        .map((a) => a.userId)
        .filter((id) => id !== actorId);

      if (notifyUserIds.length > 0) {
        await this.notificationsService.queueForMany(tx, notifyUserIds, 'COMMENT', {
          itemId,
          itemTitle: item.title,
          commentBy: actorId,
          commentPreview: dto.body.substring(0, 100),
        });
      }

      return comment;
    });
  }

  /**
   * Get a single workflow item with all relations.
   */
  async findOne(id: string) {
    const item = await this.prisma.workflowItem.findUnique({
      where: { id },
      include: {
        template: { select: { id: true, name: true } },
        currentStage: { select: { id: true, name: true, isFinal: true } },
        assignments: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        comments: {
          orderBy: { createdAt: 'desc' },
          include: { author: { select: { id: true, name: true } } },
        },
        attachments: {
          where: { isLatest: true },
          orderBy: { createdAt: 'desc' },
        },
        auditEvents: {
          orderBy: { sequenceNum: 'asc' },
          include: { actor: { select: { id: true, name: true } } },
        },
      },
    });

    if (!item) {
      throw new NotFoundException(`Workflow item ${id} not found`);
    }

    // Also return available transitions from the current stage
    const availableTransitions = await this.prisma.stageTransition.findMany({
      where: { fromStageId: item.currentStageId },
      include: {
        toStage: { select: { id: true, name: true } },
        permissions: true,
      },
    });

    return { ...item, availableTransitions };
  }

  /**
   * Get all workflow items (basic list).
   */
  async findAll(options?: {
    templateId?: string;
    stageId?: string;
    assignedUserId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (options?.templateId) where.templateId = options.templateId;
    if (options?.stageId) where.currentStageId = options.stageId;
    if (options?.assignedUserId) {
      where.assignments = { some: { userId: options.assignedUserId } };
    }

    const [items, total] = await Promise.all([
      this.prisma.workflowItem.findMany({
        where,
        include: {
          template: { select: { id: true, name: true } },
          currentStage: { select: { id: true, name: true } },
          assignments: {
            include: { user: { select: { id: true, name: true } } },
          },
          _count: { select: { comments: true, attachments: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.workflowItem.count({ where }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // --- Private helpers ---

  /**
   * Check if a user has permission to perform a transition.
   * (Extracted here, detailed in Guide 05)
   */
  private async checkTransitionPermission(
    transition: any,
    actorId: string,
  ) {
    const permissions = transition.permissions;

    // If no permissions are defined, anyone can perform the transition
    if (!permissions || permissions.length === 0) return;

    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true },
    });

    if (!actor) throw new NotFoundException('Actor not found');

    const allowed = permissions.some((perm: any) => {
      if (perm.role && actor.role === perm.role) return true;
      if (perm.userId && perm.userId === actorId) return true;
      return false;
    });

    if (!allowed) {
      throw new BadRequestException(
        `You do not have permission to perform this transition`,
      );
    }
  }

  /**
   * Internal findOne that accepts a transaction client.
   */
  private async findOneRaw(tx: any, id: string) {
    return tx.workflowItem.findUnique({
      where: { id },
      include: {
        template: { select: { id: true, name: true } },
        currentStage: { select: { id: true, name: true, isFinal: true } },
        assignments: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
  }
}
```

---

## 6. Items Controller

```typescript
// src/items/items.controller.ts
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
    @CurrentUser('id') userId: string,
  ) {
    return this.itemsService.transition(id, dto, userId);
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
```

---

## 7. Items Module

```typescript
// src/items/items.module.ts
import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
```

Update `app.module.ts`:

```typescript
// Add to imports array
import { ItemsModule } from './items/items.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    // ... existing imports
    AuditModule,
    NotificationsModule,
    ItemsModule,
  ],
})
export class AppModule {}
```

---

## 8. Key Design Pattern: Atomic State + Audit + Notification

Every write operation follows the same pattern:

```
prisma.$transaction(async (tx) => {
  1. Lock the row (SELECT ... FOR UPDATE)
  2. Version check (optimistic concurrency)
  3. Update materialized state (workflow_items)
  4. Append audit event (audit_events)
  5. Queue notification (notification_outbox)
})
```

If ANY step fails, the entire transaction rolls back — nothing is half-committed. This is the same pattern you used in Task 1 where `orders.status` and `ledger_entries` are always updated in the same transaction.

---

## 9. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 2: Create items from template | `create()` — finds start stage, creates item, records ITEM_CREATED event |
| Req 2: Assign users | `addAssignment()` / `removeAssignment()` with audit events |
| Req 2: Move through stages | `transition()` — validates, checks permissions, updates, audits |
| Req 2: Record comments | `addComment()` with audit event and notifications |
| Req 3: Enforced transitions | `transition()` validates against `stage_transitions` (expanded in Guide 05) |
| Req 4: Audit trail | Every operation records to `audit_events` via `AuditService` |
| Req 5: Concurrency safety | Version check + `FOR UPDATE` lock in `transition()` (expanded in Guide 07) |
| Req 8: Notification queue | All notifications go through `NotificationsService.queue()` in same transaction |

---

**Next: [Guide 05 — Enforced Transitions & Permissions →](./05-enforced-transitions-and-permissions.md)**
