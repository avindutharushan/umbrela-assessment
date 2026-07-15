import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, AuditEventType } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TransitionPolicyService } from '../transitions/transition-policy.service';
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
    private transitionPolicy: TransitionPolicyService,
  ) {}

  /**
   * Create a new workflow item from a template.
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
   */
  async transition(itemId: string, dto: TransitionItemDto, actor: { id: string; role: string }) {
    return this.prisma.$transaction(
      async (tx) => {
      // Fetch the item with a row-level lock (SELECT ... FOR UPDATE)
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
          error: 'VERSION_CONFLICT',
          message: 'This item has been modified by another user since you last loaded it',
          currentVersion: item.version,
          yourVersion: dto.version,
        });
      }

      // === POLICY CHECK — all validation happens here ===
      await this.transitionPolicy.validateTransition({
        itemId,
        fromStageId: item.current_stage_id,
        toStageId: dto.toStageId,
        actorId: actor.id,
        actorRole: actor.role,
      }, tx);

      // Fetch stage names for the audit event
      const [fromStage, toStage] = await Promise.all([
        tx.templateStage.findUnique({ where: { id: item.current_stage_id }, select: { name: true } }),
        tx.templateStage.findUnique({ where: { id: dto.toStageId }, select: { name: true } }),
      ]);

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
        actorId: actor.id,
        eventType: AuditEventType.STAGE_TRANSITION,
        payload: {
          fromStageId: item.current_stage_id,
          fromStageName: fromStage?.name,
          toStageId: dto.toStageId,
          toStageName: toStage?.name,
        },
      });

      // Queue notifications for all assigned users
      const assignments = await tx.workflowItemAssignment.findMany({
        where: { itemId },
        select: { userId: true },
      });

      const notifyUserIds = assignments
        .map((a) => a.userId)
        .filter((id) => id !== actor.id); // Don't notify the actor

      if (notifyUserIds.length > 0) {
        await this.notificationsService.queueForMany(
          tx,
          notifyUserIds,
          'STAGE_TRANSITION',
          {
            itemId,
            fromStage: fromStage?.name,
            toStage: toStage?.name,
            transitionedBy: actor.id,
          },
        );
      }

      return this.findOneRaw(tx, itemId);
    },
    { maxWait: 10000, timeout: 20000 },
    );
  }

  /**
   * Update a workflow item's fields (title, description, priority, dueDate).
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
          error: 'VERSION_CONFLICT',
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
