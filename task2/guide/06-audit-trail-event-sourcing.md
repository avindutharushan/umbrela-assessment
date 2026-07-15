# Guide 06 — Audit Trail & Event Sourcing

> **What you'll build in this guide:** A complete event-sourcing implementation where the audit trail is the **source of truth** — every operation produces an immutable event, and the current state of any workflow item can be reconstructed entirely by replaying its event history. This is Requirement 4 of the assessment.

---

## 1. What the Assessment Requires

> *"Every operation (creation, transition, comment, assignment change, attachment change) must generate an immutable audit event. The complete current state of any item must be reconstructable entirely by replaying its event history. Cached/materialized state is allowed for performance, but the log is the source of truth, and your tests must prove the materialized state can be rebuilt from it."*

**This is the single most important architectural pattern in Task 2.** The evaluators specifically check:
> *"Is the audit log truly the source of truth (state provably rebuildable by replay), or a side-table that could drift from 'real' state?"*

---

## 2. Event Types and Their Payloads

Each event carries the **complete data needed to reconstruct that step** — not just a reference.

| Event Type | Payload | What It Records |
|-----------|---------|-----------------|
| `ITEM_CREATED` | `{ templateId, templateName, title, description, priority, startStageId, startStageName, dueDate }` | Full initial state |
| `STAGE_TRANSITION` | `{ fromStageId, fromStageName, toStageId, toStageName, transitionName }` | Stage change |
| `FIELD_UPDATED` | `{ field, oldValue, newValue }` | Individual field change |
| `ASSIGNMENT_ADDED` | `{ userId, userName }` | User assignment |
| `ASSIGNMENT_REMOVED` | `{ userId, userName }` | User unassignment |
| `COMMENT_ADDED` | `{ commentId, body }` | Comment creation |
| `ATTACHMENT_ADDED` | `{ attachmentId, fileName, versionNum }` | File upload |
| `ATTACHMENT_REMOVED` | `{ attachmentId, fileName }` | File removal |

---

## 3. The Audit Event API Controller

```typescript
// src/audit/audit.controller.ts
import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Audit Trail')
@Controller('audit')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get('items/:itemId')
  @ApiOperation({ summary: 'Get the complete audit trail for a workflow item' })
  getItemAuditTrail(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.auditService.getEventsByItemId(itemId);
  }

  @Get('items/:itemId/reconstruct')
  @ApiOperation({
    summary: 'Reconstruct item state from event history (proves audit log is source of truth)',
  })
  reconstructState(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.auditService.reconstructStateFromEvents(itemId);
  }

  @Get('items/:itemId/verify')
  @ApiOperation({
    summary: 'Verify that materialized state matches reconstructed state (integrity check)',
  })
  verifyIntegrity(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.auditService.verifyStateIntegrity(itemId);
  }
}
```

---

## 4. State Reconstruction (The Core of Event Sourcing)

Add these methods to `audit.service.ts`:

```typescript
// src/audit/audit.service.ts — add these methods

/**
 * Reconstruct the complete state of a workflow item by replaying all its events.
 * 
 * This is the proof that the audit log is the source of truth:
 * starting from an empty state, we apply each event in sequence and
 * arrive at the current state WITHOUT reading from workflow_items.
 */
async reconstructStateFromEvents(itemId: string): Promise<ReconstructedState> {
  const events = await this.prisma.auditEvent.findMany({
    where: { itemId },
    orderBy: { sequenceNum: 'asc' },
  });

  if (events.length === 0) {
    throw new NotFoundException(`No events found for item ${itemId}`);
  }

  // Start from empty state
  const state: ReconstructedState = {
    id: itemId,
    templateId: null,
    title: null,
    description: null,
    priority: null,
    currentStageId: null,
    currentStageName: null,
    dueDate: null,
    assignments: new Set<string>(),
    commentCount: 0,
    attachments: new Map<string, { fileName: string; versionNum: number }>(),
    eventCount: events.length,
    lastEventAt: null,
  };

  // Replay each event in order
  for (const event of events) {
    this.applyEvent(state, event);
  }

  return {
    ...state,
    assignments: Array.from(state.assignments),
    attachments: Array.from(state.attachments.values()),
  };
}

/**
 * Verify that the materialized state in workflow_items matches
 * the state reconstructed from events.
 * 
 * This is what your tests will call to prove the audit log isn't
 * just a side-table that can drift from "real" state.
 */
async verifyStateIntegrity(itemId: string): Promise<IntegrityCheckResult> {
  // Get materialized state
  const materialized = await this.prisma.workflowItem.findUnique({
    where: { id: itemId },
    include: {
      assignments: { select: { userId: true } },
      currentStage: { select: { id: true, name: true } },
    },
  });

  if (!materialized) {
    throw new NotFoundException(`Workflow item ${itemId} not found`);
  }

  // Reconstruct from events
  const reconstructed = await this.reconstructStateFromEvents(itemId);

  // Compare
  const mismatches: string[] = [];

  if (materialized.title !== reconstructed.title) {
    mismatches.push(`title: materialized="${materialized.title}" vs reconstructed="${reconstructed.title}"`);
  }
  if (materialized.description !== reconstructed.description) {
    mismatches.push(`description mismatch`);
  }
  if (materialized.priority !== reconstructed.priority) {
    mismatches.push(`priority: materialized="${materialized.priority}" vs reconstructed="${reconstructed.priority}"`);
  }
  if (materialized.currentStageId !== reconstructed.currentStageId) {
    mismatches.push(`currentStageId: materialized="${materialized.currentStageId}" vs reconstructed="${reconstructed.currentStageId}"`);
  }

  const materializedAssignees = new Set(materialized.assignments.map((a) => a.userId));
  const reconstructedAssignees = new Set(reconstructed.assignments as string[]);

  if (materializedAssignees.size !== reconstructedAssignees.size ||
      ![...materializedAssignees].every((id) => reconstructedAssignees.has(id))) {
    mismatches.push('assignments mismatch');
  }

  return {
    itemId,
    isConsistent: mismatches.length === 0,
    mismatches,
    materializedState: {
      title: materialized.title,
      priority: materialized.priority,
      currentStage: materialized.currentStage.name,
      assigneeCount: materialized.assignments.length,
    },
    reconstructedState: {
      title: reconstructed.title,
      priority: reconstructed.priority,
      currentStage: reconstructed.currentStageName,
      assigneeCount: (reconstructed.assignments as string[]).length,
    },
    eventCount: reconstructed.eventCount,
  };
}

/**
 * Apply a single event to the state accumulator.
 * This is the "reducer" function — pure, deterministic, testable.
 */
private applyEvent(state: ReconstructedState, event: any): void {
  const payload = event.payload as Record<string, any>;
  state.lastEventAt = event.createdAt;

  switch (event.eventType) {
    case 'ITEM_CREATED':
      state.templateId = payload.templateId;
      state.title = payload.title;
      state.description = payload.description || null;
      state.priority = payload.priority || 'MEDIUM';
      state.currentStageId = payload.startStageId;
      state.currentStageName = payload.startStageName;
      state.dueDate = payload.dueDate || null;
      break;

    case 'STAGE_TRANSITION':
      state.currentStageId = payload.toStageId;
      state.currentStageName = payload.toStageName;
      break;

    case 'FIELD_UPDATED':
      if (payload.field === 'title') state.title = payload.newValue;
      if (payload.field === 'description') state.description = payload.newValue;
      if (payload.field === 'priority') state.priority = payload.newValue;
      if (payload.field === 'dueDate') state.dueDate = payload.newValue;
      break;

    case 'ASSIGNMENT_ADDED':
      (state.assignments as Set<string>).add(payload.userId);
      break;

    case 'ASSIGNMENT_REMOVED':
      (state.assignments as Set<string>).delete(payload.userId);
      break;

    case 'COMMENT_ADDED':
      state.commentCount++;
      break;

    case 'ATTACHMENT_ADDED':
      (state.attachments as Map<string, any>).set(payload.attachmentId, {
        fileName: payload.fileName,
        versionNum: payload.versionNum,
      });
      break;

    case 'ATTACHMENT_REMOVED':
      (state.attachments as Map<string, any>).delete(payload.attachmentId);
      break;
  }
}

// --- Type definitions ---

interface ReconstructedState {
  id: string;
  templateId: string | null;
  title: string | null;
  description: string | null;
  priority: string | null;
  currentStageId: string | null;
  currentStageName: string | null;
  dueDate: string | null;
  assignments: Set<string> | string[];
  commentCount: number;
  attachments: Map<string, any> | any[];
  eventCount: number;
  lastEventAt: Date | null;
}

interface IntegrityCheckResult {
  itemId: string;
  isConsistent: boolean;
  mismatches: string[];
  materializedState: Record<string, any>;
  reconstructedState: Record<string, any>;
  eventCount: number;
}
```

Update `audit.module.ts`:

```typescript
// src/audit/audit.module.ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

---

## 5. Integration Tests — Proving the Source of Truth

This is the critical test the evaluators will look for:

```typescript
// test/audit-event-sourcing.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Event Sourcing — State Reconstruction (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  let templateId: string;
  let itemId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Clean database
    await prisma.auditEvent.deleteMany();
    await prisma.workflowItemAssignment.deleteMany();
    await prisma.workflowItemComment.deleteMany();
    await prisma.workflowItem.deleteMany();
    await prisma.transitionPermission.deleteMany();
    await prisma.stageTransition.deleteMany();
    await prisma.templateStage.deleteMany();
    await prisma.workflowTemplate.deleteMany();
    await prisma.user.deleteMany();

    // Create users and get tokens
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'admin@test.com', name: 'Admin', password: 'password123', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'user@test.com', name: 'User', password: 'password123' });
    userToken = userRes.body.accessToken;

    // Create a template
    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Workflow',
        stages: [
          { name: 'Draft', isStart: true, position: 0 },
          { name: 'Review', position: 1 },
          { name: 'Done', isFinal: true, position: 2 },
        ],
        transitions: [
          { fromStageName: 'Draft', toStageName: 'Review', name: 'Submit', permissions: [{ role: 'USER' }] },
          { fromStageName: 'Review', toStageName: 'Done', name: 'Approve', permissions: [{ role: 'ADMIN' }] },
          { fromStageName: 'Review', toStageName: 'Draft', name: 'Reject', permissions: [{ role: 'ADMIN' }] },
        ],
      });
    templateId = templateRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should reconstruct item state from events after multiple operations', async () => {
    // 1. Create item
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        templateId,
        title: 'Original Title',
        description: 'Original description',
        priority: 'LOW',
      });
    
    expect(createRes.status).toBe(201);
    itemId = createRes.body.id;
    let version = createRes.body.version;

    // 2. Update title
    const updateRes = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ title: 'Updated Title', version });
    version = updateRes.body.version;

    // 3. Update priority
    const priorityRes = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ priority: 'HIGH', version });
    version = priorityRes.body.version;

    // 4. Get stage IDs from template
    const templateRes = await request(app.getHttpServer())
      .get(`/api/templates/${templateId}`)
      .set('Authorization', `Bearer ${userToken}`);
    
    const stages = templateRes.body.stages;
    const reviewStageId = stages.find((s: any) => s.name === 'Review').id;
    const draftStageId = stages.find((s: any) => s.name === 'Draft').id;
    const doneStageId = stages.find((s: any) => s.name === 'Done').id;

    // 5. Transition: Draft → Review
    const transRes = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ toStageId: reviewStageId, version });
    version = transRes.body.version;

    // 6. Transition: Review → Draft (send back)
    const rejectRes = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStageId: draftStageId, version });
    version = rejectRes.body.version;

    // 7. Transition: Draft → Review (re-submit)
    const resubmitRes = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ toStageId: reviewStageId, version });
    version = resubmitRes.body.version;

    // 8. Transition: Review → Done (approve)
    const approveRes = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStageId: doneStageId, version });

    // === NOW VERIFY: reconstructed state matches materialized state ===
    const verifyRes = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/verify`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.isConsistent).toBe(true);
    expect(verifyRes.body.mismatches).toEqual([]);
    expect(verifyRes.body.eventCount).toBeGreaterThanOrEqual(6); // create + 2 updates + 4 transitions

    // Also verify the reconstructed state directly
    const reconstructRes = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/reconstruct`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(reconstructRes.status).toBe(200);
    expect(reconstructRes.body.title).toBe('Updated Title');
    expect(reconstructRes.body.priority).toBe('HIGH');
    expect(reconstructRes.body.currentStageName).toBe('Done');
  });

  it('should reconstruct state with assignments correctly', async () => {
    // Create a new item
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ templateId, title: 'Assignment Test' });
    
    const testItemId = createRes.body.id;
    const userProfile = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${userToken}`);
    const userId = userProfile.body.id;

    // Add assignment
    await request(app.getHttpServer())
      .post(`/api/items/${testItemId}/assignments`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId });

    // Remove assignment
    await request(app.getHttpServer())
      .delete(`/api/items/${testItemId}/assignments/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Verify integrity
    const verifyRes = await request(app.getHttpServer())
      .get(`/api/audit/items/${testItemId}/verify`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(verifyRes.body.isConsistent).toBe(true);
    expect(verifyRes.body.reconstructedState.assigneeCount).toBe(0);
  });
});
```

---

## 6. Why This Matters for the Assessment

The evaluators distinguish between two approaches:

| ❌ Side-table approach (fails the test) | ✅ Source-of-truth approach (our design) |
|---|---|
| Audit log records actions after the fact | Audit log IS the canonical state |
| If audit insert fails, main state is still updated | Audit + state update are in the SAME transaction |
| State can drift from the log | State is provably rebuildable from the log |
| Log is for display only | Log powers crash recovery (Guide 08) |

Our design ensures the audit log can never drift because:
1. State update and event insert happen in the **same DB transaction**
2. The `reconstructStateFromEvents()` function proves state is rebuildable
3. `verifyStateIntegrity()` compares reconstructed vs. materialized state
4. Tests exercise the full lifecycle (create → update → transition → verify)

---

## 7. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 4: Every operation generates an audit event | All event types covered: create, transition, field update, assignment, comment, attachment |
| Req 4: State reconstructable from events | `reconstructStateFromEvents()` — pure event replay |
| Req 4: Cached state is allowed | `workflow_items` is materialized/cached; `audit_events` is truth |
| Req 4: Tests prove rebuild | Integration test exercises full lifecycle then verifies consistency |
| Source of truth vs. side-table | Same-transaction writes, integrity verification API |

---

**Next: [Guide 07 — Concurrency Safety →](./07-concurrency-safety.md)**
