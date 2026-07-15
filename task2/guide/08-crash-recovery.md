# Guide 08 — Crash Recovery

> **What you'll build in this guide:** A `reconcile()` mechanism that detects and repairs inconsistencies between the audit event log and the materialized state — proving that the system can recover from a crash that occurs mid-operation. This is Requirement 7 of the assessment.

---

## 1. What the Assessment Requires

> *"Simulate a server failure occurring during a transition — after an audit event has been recorded but before all related materialized data has been updated. Implement a reconcile() mechanism that rebuilds state from the immutable event history and safely resolves the incomplete operation. Document your chosen recovery strategy (complete vs. roll back) and why."*

---

## 2. Recovery Strategy: Complete Forward

### Why complete forward, not rollback?

| Strategy | How it works | Trade-off |
|----------|-------------|-----------|
| **Rollback** | Delete the "orphan" audit event | ❌ Violates the append-only invariant of the audit log. If we delete events, the log is no longer immutable — which undermines the entire event-sourcing architecture. |
| **Complete forward** ✅ | Re-derive materialized state from the audit events | ✅ Preserves the immutable log. The audit event was committed, so the operation DID happen — we just need to finish applying it to the materialized state. |

We choose **complete forward** because:
1. The audit log is append-only by design — no deletes allowed
2. If the event was committed, the user's intent was recorded — the operation logically happened
3. It's simpler: just replay events and rebuild, no need to figure out "which event to undo"
4. It's the same mechanism used for `verifyStateIntegrity()` in Guide 06

---

## 3. The Reconcile Service

```typescript
// src/audit/reconcile.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

export interface ReconcileResult {
  itemId: string;
  wasInconsistent: boolean;
  changes: string[];
  previousState: Record<string, any>;
  reconciledState: Record<string, any>;
  eventsReplayed: number;
}

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
  ) {}

  /**
   * Reconcile a single workflow item by rebuilding its materialized state
   * from the immutable audit event history.
   * 
   * This is the crash recovery mechanism: if a server crash occurs AFTER
   * an audit event is written but BEFORE the materialized state is updated,
   * calling reconcile() will bring the materialized state back into sync.
   * 
   * Strategy: COMPLETE FORWARD — we treat the audit log as truth and
   * rebuild the cached state to match it.
   */
  async reconcileItem(itemId: string): Promise<ReconcileResult> {
    this.logger.log(`Reconciling item ${itemId}...`);

    // 1. Reconstruct the "should-be" state from events
    const reconstructed = await this.auditService.reconstructStateFromEvents(itemId);

    // 2. Read the current materialized state
    const current = await this.prisma.workflowItem.findUnique({
      where: { id: itemId },
      include: {
        assignments: { select: { userId: true } },
        currentStage: { select: { id: true, name: true } },
      },
    });

    if (!current) {
      // Edge case: audit events exist but the item row doesn't.
      // This means the crash happened after the audit event but before the item was created.
      // Complete forward: create the item from the ITEM_CREATED event.
      return this.reconcileFromScratch(itemId, reconstructed);
    }

    // 3. Compare and fix
    const changes: string[] = [];
    const updateData: Record<string, any> = {};

    if (current.title !== reconstructed.title) {
      changes.push(`title: "${current.title}" → "${reconstructed.title}"`);
      updateData.title = reconstructed.title;
    }

    if (current.description !== reconstructed.description) {
      changes.push(`description: updated`);
      updateData.description = reconstructed.description;
    }

    if (current.priority !== reconstructed.priority) {
      changes.push(`priority: "${current.priority}" → "${reconstructed.priority}"`);
      updateData.priority = reconstructed.priority;
    }

    if (current.currentStageId !== reconstructed.currentStageId) {
      changes.push(
        `currentStage: "${current.currentStage.name}" → "${reconstructed.currentStageName}"`,
      );
      updateData.currentStageId = reconstructed.currentStageId;
    }

    // Reconcile assignments
    const currentAssignees = new Set(current.assignments.map((a) => a.userId));
    const targetAssignees = new Set(reconstructed.assignments as string[]);

    const toAdd = [...targetAssignees].filter((id) => !currentAssignees.has(id));
    const toRemove = [...currentAssignees].filter((id) => !targetAssignees.has(id));

    if (toAdd.length > 0 || toRemove.length > 0) {
      changes.push(`assignments: +${toAdd.length} -${toRemove.length}`);
    }

    const wasInconsistent = changes.length > 0;

    if (wasInconsistent) {
      this.logger.warn(`Item ${itemId} is INCONSISTENT. Applying ${changes.length} fixes...`);

      await this.prisma.$transaction(async (tx) => {
        // Update the item
        if (Object.keys(updateData).length > 0) {
          await tx.workflowItem.update({
            where: { id: itemId },
            data: updateData,
          });
        }

        // Fix assignments
        for (const userId of toAdd) {
          await tx.workflowItemAssignment.create({
            data: { itemId, userId },
          }).catch(() => {
            // Assignment might already exist — ignore
          });
        }

        for (const userId of toRemove) {
          await tx.workflowItemAssignment.deleteMany({
            where: { itemId, userId },
          });
        }
      });

      this.logger.log(`Item ${itemId} reconciled successfully`);
    } else {
      this.logger.log(`Item ${itemId} is consistent — no changes needed`);
    }

    return {
      itemId,
      wasInconsistent,
      changes,
      previousState: {
        title: current.title,
        priority: current.priority,
        currentStage: current.currentStage.name,
        assigneeCount: current.assignments.length,
      },
      reconciledState: {
        title: reconstructed.title,
        priority: reconstructed.priority,
        currentStage: reconstructed.currentStageName,
        assigneeCount: (reconstructed.assignments as string[]).length,
      },
      eventsReplayed: reconstructed.eventCount,
    };
  }

  /**
   * Reconcile ALL items — useful for startup/health checks.
   */
  async reconcileAll(): Promise<{
    total: number;
    inconsistent: number;
    results: ReconcileResult[];
  }> {
    this.logger.log('Starting full reconciliation...');

    const items = await this.prisma.workflowItem.findMany({
      select: { id: true },
    });

    const results: ReconcileResult[] = [];
    for (const item of items) {
      try {
        const result = await this.reconcileItem(item.id);
        results.push(result);
      } catch (error) {
        this.logger.error(`Failed to reconcile item ${item.id}:`, error);
      }
    }

    const inconsistent = results.filter((r) => r.wasInconsistent).length;

    this.logger.log(
      `Reconciliation complete. ${items.length} items checked, ${inconsistent} fixed.`,
    );

    return {
      total: items.length,
      inconsistent,
      results: results.filter((r) => r.wasInconsistent), // Only return the ones that had issues
    };
  }

  /**
   * Handle the edge case where audit events exist but the item row doesn't.
   */
  private async reconcileFromScratch(
    itemId: string,
    reconstructed: any,
  ): Promise<ReconcileResult> {
    this.logger.warn(`Item ${itemId} has events but no row — creating from events...`);

    await this.prisma.$transaction(async (tx) => {
      await tx.workflowItem.create({
        data: {
          id: itemId,
          templateId: reconstructed.templateId,
          title: reconstructed.title || 'Recovered Item',
          description: reconstructed.description,
          priority: reconstructed.priority || 'MEDIUM',
          currentStageId: reconstructed.currentStageId,
          dueDate: reconstructed.dueDate ? new Date(reconstructed.dueDate) : null,
        },
      });

      for (const userId of reconstructed.assignments as string[]) {
        await tx.workflowItemAssignment.create({
          data: { itemId, userId },
        }).catch(() => {});
      }
    });

    return {
      itemId,
      wasInconsistent: true,
      changes: ['Created item row from event history (crash during creation)'],
      previousState: { exists: false },
      reconciledState: {
        title: reconstructed.title,
        priority: reconstructed.priority,
        currentStage: reconstructed.currentStageName,
      },
      eventsReplayed: reconstructed.eventCount,
    };
  }
}
```

---

## 4. Reconcile Controller

```typescript
// src/audit/reconcile.controller.ts
import { Controller, Post, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReconcileService } from './reconcile.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Crash Recovery')
@Controller('reconcile')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ReconcileController {
  constructor(private reconcileService: ReconcileService) {}

  @Post('items/:itemId')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Reconcile a single item from audit events (admin only)' })
  reconcileItem(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.reconcileService.reconcileItem(itemId);
  }

  @Post('all')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Reconcile all items from audit events (admin only)' })
  reconcileAll() {
    return this.reconcileService.reconcileAll();
  }
}
```

Update `audit.module.ts`:

```typescript
// src/audit/audit.module.ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { ReconcileService } from './reconcile.service';
import { ReconcileController } from './reconcile.controller';

@Module({
  controllers: [AuditController, ReconcileController],
  providers: [AuditService, ReconcileService],
  exports: [AuditService, ReconcileService],
})
export class AuditModule {}
```

---

## 5. Crash Recovery Test

```typescript
// test/crash-recovery.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Crash Recovery — reconcile() (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  let templateId: string;
  let reviewStageId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    // Setup
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'admin@crash.com', name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'user@crash.com', name: 'User', password: 'pass12345' });
    userToken = userRes.body.accessToken;

    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Crash Test Template',
        stages: [
          { name: 'Draft', isStart: true },
          { name: 'Review' },
          { name: 'Done', isFinal: true },
        ],
        transitions: [
          { fromStageName: 'Draft', toStageName: 'Review', name: 'Submit', permissions: [{ role: 'USER' }] },
          { fromStageName: 'Review', toStageName: 'Done', name: 'Approve', permissions: [{ role: 'ADMIN' }] },
        ],
      });
    templateId = templateRes.body.id;

    const stagesRes = await request(app.getHttpServer())
      .get(`/api/templates/${templateId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    reviewStageId = stagesRes.body.stages.find((s: any) => s.name === 'Review').id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should recover from a crash where audit event was written but materialized state was not updated', async () => {
    // 1. Create a normal item (this works fine)
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ templateId, title: 'Crash Test Item' });

    const itemId = createRes.body.id;

    // 2. Perform a normal transition (works fine)
    await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ toStageId: reviewStageId, version: 1 });

    // 3. SIMULATE A CRASH: We manually write an audit event for a
    //    field update that "happened" but the materialized state was
    //    NOT updated (simulating a crash between event write and state write).
    const adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

    // Get the latest sequence number
    const lastEvent = await prisma.auditEvent.findFirst({
      where: { itemId },
      orderBy: { sequenceNum: 'desc' },
    });

    // Write an "orphan" audit event — the event says priority changed,
    // but the workflow_items row still has the old priority
    await prisma.auditEvent.create({
      data: {
        itemId,
        actorId: adminUser!.id,
        eventType: 'FIELD_UPDATED',
        payload: { field: 'priority', oldValue: 'MEDIUM', newValue: 'URGENT' },
        sequenceNum: (lastEvent?.sequenceNum ?? 0) + 1,
      },
    });

    // 4. Verify the inconsistency EXISTS
    const verifyBefore = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(verifyBefore.body.isConsistent).toBe(false);
    expect(verifyBefore.body.mismatches).toContainEqual(
      expect.stringContaining('priority'),
    );

    // 5. RUN RECONCILE — this should fix the inconsistency
    const reconcileRes = await request(app.getHttpServer())
      .post(`/api/reconcile/items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reconcileRes.status).toBe(201);
    expect(reconcileRes.body.wasInconsistent).toBe(true);
    expect(reconcileRes.body.changes).toContainEqual(
      expect.stringContaining('priority'),
    );

    // 6. Verify the inconsistency is FIXED
    const verifyAfter = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(verifyAfter.body.isConsistent).toBe(true);
    expect(verifyAfter.body.mismatches).toEqual([]);

    // 7. Verify the materialized state now matches
    const item = await prisma.workflowItem.findUnique({ where: { id: itemId } });
    expect(item!.priority).toBe('URGENT'); // Fixed by reconcile!
  });

  it('should report no changes when item is already consistent', async () => {
    // Create a normal, consistent item
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ templateId, title: 'Consistent Item' });

    const itemId = createRes.body.id;

    // Reconcile should find no issues
    const reconcileRes = await request(app.getHttpServer())
      .post(`/api/reconcile/items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reconcileRes.body.wasInconsistent).toBe(false);
    expect(reconcileRes.body.changes).toEqual([]);
  });

  it('should handle simulated crash during stage transition', async () => {
    // Create item
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ templateId, title: 'Stage Crash Test' });

    const itemId = createRes.body.id;
    const adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

    // Get current stage info
    const item = await prisma.workflowItem.findUnique({
      where: { id: itemId },
      include: { currentStage: true },
    });

    // Write orphan transition event (event says it moved to Review, but item row still says Draft)
    const lastEvent = await prisma.auditEvent.findFirst({
      where: { itemId },
      orderBy: { sequenceNum: 'desc' },
    });

    await prisma.auditEvent.create({
      data: {
        itemId,
        actorId: adminUser!.id,
        eventType: 'STAGE_TRANSITION',
        payload: {
          fromStageId: item!.currentStageId,
          fromStageName: item!.currentStage.name,
          toStageId: reviewStageId,
          toStageName: 'Review',
        },
        sequenceNum: (lastEvent?.sequenceNum ?? 0) + 1,
      },
    });

    // Item is now inconsistent: events say "Review", row says "Draft"
    const verifyBefore = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(verifyBefore.body.isConsistent).toBe(false);

    // Reconcile fixes it
    const reconcileRes = await request(app.getHttpServer())
      .post(`/api/reconcile/items/${itemId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(reconcileRes.body.wasInconsistent).toBe(true);
    expect(reconcileRes.body.changes).toContainEqual(
      expect.stringContaining('currentStage'),
    );

    // Now consistent
    const verifyAfter = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(verifyAfter.body.isConsistent).toBe(true);

    // Materialized state updated
    const fixedItem = await prisma.workflowItem.findUnique({
      where: { id: itemId },
      include: { currentStage: true },
    });
    expect(fixedItem!.currentStage.name).toBe('Review');
  });
});
```

---

## 6. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 7: Simulate server failure | Tests manually write orphan audit events to simulate crash mid-operation |
| Req 7: reconcile() mechanism | `ReconcileService.reconcileItem()` rebuilds from events |
| Req 7: Document recovery strategy | Complete forward — preserves immutable audit log |
| Req 7: Safely resolves incomplete operation | Brings materialized state into sync with event history |

---

**Next: [Guide 09 — Document Attachments →](./09-document-attachments.md)**
