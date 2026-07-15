import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TransitionContext {
  itemId: string;
  fromStageId: string;
  toStageId: string;
  actorId: string;
  actorRole: string;
}

export interface TransitionValidationResult {
  allowed: boolean;
  reason?: string;
  transition?: any;
}

@Injectable()
export class TransitionPolicyService {
  constructor(private prisma: PrismaService) {}

  /**
   * Validate whether a transition is allowed.
   */
  async validateTransition(ctx: TransitionContext, tx: any = this.prisma): Promise<void> {
    // 1. Does this transition exist?
    const transition = await tx.stageTransition.findUnique({
      where: {
        fromStageId_toStageId: {
          fromStageId: ctx.fromStageId,
          toStageId: ctx.toStageId,
        },
      },
      include: {
        fromStage: { select: { id: true, name: true, templateId: true } },
        toStage: { select: { id: true, name: true } },
        permissions: true,
      },
    });

    if (!transition) {
      throw new BadRequestException({
        error: 'INVALID_TRANSITION',
        message: `No valid transition exists from the current stage to the target stage`,
        fromStageId: ctx.fromStageId,
        toStageId: ctx.toStageId,
      });
    }

    // 2. Is the item actually in the source stage?
    const item = await tx.workflowItem.findUnique({
      where: { id: ctx.itemId },
      select: { currentStageId: true, templateId: true },
    });

    if (!item) {
      throw new NotFoundException(`Workflow item ${ctx.itemId} not found`);
    }

    if (item.currentStageId !== ctx.fromStageId) {
      throw new BadRequestException({
        error: 'STALE_STATE',
        message: 'The item is no longer in the expected stage. It may have been transitioned by another user.',
        expectedStage: ctx.fromStageId,
        actualStage: item.currentStageId,
      });
    }

    // Verify the transition belongs to the same template as the item
    if (transition.fromStage.templateId !== item.templateId) {
      throw new BadRequestException({
        error: 'TEMPLATE_MISMATCH',
        message: 'The transition does not belong to this item\'s template',
      });
    }

    // 4. Check Roles
    const hasRolePermission = transition.permissions.some(
      (p) => p.role === ctx.actorRole,
    );
    if (hasRolePermission) return;

    // 5. Check if Assignee
    const isAssigneeAllowed = transition.permissions.some(
      (p) => p.isAssigneeAllowed,
    );
    if (isAssigneeAllowed) {
      const isAssigned = await tx.workflowItemAssignment.findFirst({
        where: {
          itemId: ctx.itemId,
          userId: ctx.actorId,
        },
      });
      if (isAssigned) return;
    }

    // 6. Check if Creator
    const isCreatorAllowed = transition.permissions.some(
      (p) => p.isCreatorAllowed,
    );
    if (isCreatorAllowed) {
      const template = await tx.workflowTemplate.findUnique({
        where: { id: item.templateId },
        select: { createdBy: true },
      });
      if (template?.createdBy === ctx.actorId) return;
    }
    
    throw new ForbiddenException({
      error: 'TRANSITION_FORBIDDEN',
      message: 'You do not have permission to perform this transition',
    });
  }

  /**
   * Get all transitions available to a specific user for a specific item.
   */
  async getAvailableTransitions(itemId: string, actorId: string, actorRole: string) {
    const item = await this.prisma.workflowItem.findUnique({
      where: { id: itemId },
      select: { currentStageId: true },
    });

    if (!item) {
      throw new NotFoundException(`Workflow item ${itemId} not found`);
    }

    // Get all outgoing transitions from the current stage
    const transitions = await this.prisma.stageTransition.findMany({
      where: { fromStageId: item.currentStageId },
      include: {
        toStage: { select: { id: true, name: true, isFinal: true } },
        permissions: true,
      },
    });

    // Filter to only those the actor is allowed to perform
    return transitions.filter((t) => {
      try {
        this.checkPermission(t.permissions, actorId, actorRole);
        return true;
      } catch {
        return false;
      }
    }).map((t) => ({
      transitionId: t.id,
      toStageId: t.toStage.id,
      toStageName: t.toStage.name,
      isFinal: t.toStage.isFinal,
      name: t.name,
    }));
  }

  /**
   * Core permission check
   */
  private checkPermission(
    permissions: Array<{ role: string | null; userId: string | null }>,
    actorId: string,
    actorRole: string,
  ): void {
    // No permissions defined = open to all authenticated users
    if (!permissions || permissions.length === 0) {
      return;
    }

    const allowed = permissions.some((perm) => {
      // Role-based check
      if (perm.role && perm.role === actorRole) return true;
      // User-specific check
      if (perm.userId && perm.userId === actorId) return true;
      return false;
    });

    if (!allowed) {
      throw new ForbiddenException({
        error: 'TRANSITION_FORBIDDEN',
        message: 'You do not have permission to perform this transition',
        requiredPermissions: permissions.map((p) => ({
          role: p.role,
          userId: p.userId,
        })),
      });
    }
  }
}
