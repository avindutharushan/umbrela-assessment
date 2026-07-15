# Guide 05 — Enforced Transitions & Permissions

> **What you'll build in this guide:** A robust server-side transition validation and permission enforcement system — ensuring that every stage transition is validated against the template's rules and that only authorized users can perform specific transitions. This is Requirement 3 of the assessment.

---

## 1. What the Assessment Requires

> *"Every stage transition must be validated against the template's rules server-side. Invalid transitions must be rejected. Authorization must never rely on the frontend."*

What evaluators specifically look for:
> *"Do they treat permissions as configuration (data-driven per template) or as scattered if statements?"*

Our approach: **Permissions are stored as data** in `transition_permissions` — the engine reads them at runtime, not from hardcoded `if` blocks.

---

## 2. Architecture: The Policy Layer

Following your Task 1 pattern where `canReleaseFunds(user, order)` was a standalone policy function, we create a dedicated **Transition Policy Service** that sits between the controller and the item service.

```
Controller → TransitionPolicyService → ItemsService → Database
                     ↓
              Reads permissions from DB
              (data-driven, not hardcoded)
```

---

## 3. Transition Policy Service

```typescript
// src/transitions/transition-policy.service.ts
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
   * 
   * Checks three things in order:
   * 1. Does the transition exist in the template? (structural validity)
   * 2. Is the item currently in the correct source stage? (state validity)
   * 3. Does the actor have permission? (authorization)
   * 
   * This function throws on failure — the caller never has to check the result.
   */
  async validateTransition(ctx: TransitionContext): Promise<void> {
    // 1. Does this transition exist?
    const transition = await this.prisma.stageTransition.findUnique({
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
    const item = await this.prisma.workflowItem.findUnique({
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

    // 3. Permission check
    this.checkPermission(transition.permissions, ctx.actorId, ctx.actorRole);
  }

  /**
   * Get all transitions available to a specific user for a specific item.
   * 
   * This powers the UI — the frontend only shows buttons for transitions
   * the current user is allowed to perform.
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
   * Core permission check — data-driven, not hardcoded.
   * 
   * Permission rules (from transition_permissions table):
   * - If NO permissions are defined → transition is OPEN to all authenticated users
   * - If role-based permission exists → user's role must match
   * - If user-specific permission exists → user's ID must match
   * - Multiple permissions use OR logic (any match = allowed)
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
```

---

## 4. Updated Items Service (Using Policy Layer)

Update the `transition` method in `items.service.ts` to use the policy service:

```typescript
// In items.service.ts — update constructor
constructor(
  private prisma: PrismaService,
  private auditService: AuditService,
  private notificationsService: NotificationsService,
  private transitionPolicy: TransitionPolicyService, // ADD THIS
) {}

// Update the transition method
async transition(itemId: string, dto: TransitionItemDto, actor: { id: string; role: string }) {
  return this.prisma.$transaction(async (tx) => {
    // Lock the row
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
    });

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
        version: { increment: 1 },
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

    // Notify assigned users
    const assignments = await tx.workflowItemAssignment.findMany({
      where: { itemId },
      select: { userId: true },
    });
    const notifyUserIds = assignments.map((a) => a.userId).filter((id) => id !== actor.id);

    if (notifyUserIds.length > 0) {
      await this.notificationsService.queueForMany(tx, notifyUserIds, 'STAGE_TRANSITION', {
        itemId,
        fromStage: fromStage?.name,
        toStage: toStage?.name,
        transitionedBy: actor.id,
      });
    }

    return this.findOneRaw(tx, itemId);
  });
}
```

---

## 5. Transitions Module

```typescript
// src/transitions/transitions.module.ts
import { Module } from '@nestjs/common';
import { TransitionPolicyService } from './transition-policy.service';

@Module({
  providers: [TransitionPolicyService],
  exports: [TransitionPolicyService],
})
export class TransitionsModule {}
```

Update `ItemsModule` to import it:

```typescript
// src/items/items.module.ts
import { TransitionsModule } from '../transitions/transitions.module';

@Module({
  imports: [AuditModule, NotificationsModule, TransitionsModule],
  // ...
})
export class ItemsModule {}
```

---

## 6. Tests for Permission Enforcement

```typescript
// src/transitions/transition-policy.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { TransitionPolicyService } from './transition-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('TransitionPolicyService', () => {
  let service: TransitionPolicyService;

  const mockPrisma = {
    stageTransition: { findUnique: jest.fn(), findMany: jest.fn() },
    workflowItem: { findUnique: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransitionPolicyService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TransitionPolicyService>(TransitionPolicyService);
    jest.clearAllMocks();
  });

  describe('validateTransition', () => {
    it('should reject an invalid transition (no edge in graph)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue(null);

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-c', // no direct edge
          actorId: 'user-1',
          actorRole: 'USER',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when user lacks permission (role-based)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [{ role: 'ADMIN', userId: null }], // Only ADMIN allowed
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'user-1',
          actorRole: 'USER', // Not ADMIN!
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow when user has role-based permission', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [{ role: 'USER', userId: null }],
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'user-1',
          actorRole: 'USER',
        }),
      ).resolves.toBeUndefined();
    });

    it('should allow when user has user-specific permission', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [{ role: null, userId: 'specific-user-id' }],
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'specific-user-id',
          actorRole: 'USER',
        }),
      ).resolves.toBeUndefined();
    });

    it('should allow open transitions (no permissions defined)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [], // No permissions = open to all
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'any-user',
          actorRole: 'USER',
        }),
      ).resolves.toBeUndefined();
    });

    it('should reject when item is in a different stage (stale state)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [],
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-c', // Item already moved to stage-c!
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a', // Client thinks it's still in stage-a
          toStageId: 'stage-b',
          actorId: 'user-1',
          actorRole: 'USER',
        }),
      ).rejects.toThrow('no longer in the expected stage');
    });
  });
});
```

---

## 7. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 3: Server-side validation | `validateTransition()` checks structural validity, state validity, and authorization |
| Req 3: Invalid transition rejection | Throws `BadRequestException` with structured error response |
| Req 3: Authorization never relies on frontend | Policy checks happen server-side; frontend only shows available transitions |
| Permissions as configuration | `transition_permissions` table — data-driven, not hardcoded if-statements |
| Policy layer pattern | `TransitionPolicyService` is separate from controller and service — testable in isolation |

---

**Next: [Guide 06 — Audit Trail & Event Sourcing →](./06-audit-trail-event-sourcing.md)**
