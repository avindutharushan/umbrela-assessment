# Guide 07 — Concurrency Safety

> **What you'll build in this guide:** Stress tests proving that concurrent transitions and field edits are handled safely — exactly one valid transition succeeds under contention, no corrupted state, no lost updates, clear conflict responses. This covers Requirements 5 and 6 of the assessment.

---

## 1. What the Assessment Requires

### Requirement 5 — Transition Concurrency:
> *"Provide a stress test simulating at least 20 concurrent users attempting to transition the same workflow item simultaneously. Exactly one valid transition must succeed; all others must fail gracefully with a well-defined conflict response. No corrupted state, no duplicate transitions, no lost updates."*

### Requirement 6 — Field Edit Concurrency:
> *"Separately from stage transitions, simulate two users concurrently editing a non-append field on the same item (e.g., due date, priority, description) and demonstrate your conflict-detection/resolution strategy."*

---

## 2. Our Concurrency Strategy: Two Layers of Defense

### Layer 1: Optimistic Concurrency (Version Numbers)
Every `workflow_item` has a `version` column. The client sends its known version with every update. If the version doesn't match, the update is rejected with a 409 Conflict.

This is the **same pattern** you used in Task 1 with `orders.version`.

### Layer 2: Pessimistic Row Lock (SELECT ... FOR UPDATE)
Inside the transaction, we acquire a row-level lock before checking the version. This prevents the race condition where two requests both read version=1 and both try to write version=2.

```
Without row lock (BROKEN):              With row lock (CORRECT):
  T1: SELECT version → 1                  T1: SELECT ... FOR UPDATE → 1 (locks row)
  T2: SELECT version → 1                  T2: SELECT ... FOR UPDATE → WAITS
  T1: UPDATE version = 2 → ✅             T1: UPDATE version = 2, COMMIT → ✅
  T2: UPDATE version = 2 → ✅ (WRONG!)    T2: SELECT ... FOR UPDATE → 2 (sees new version)
                                           T2: Version mismatch → 409 Conflict ✅
```

### Why both layers?
- **Optimistic concurrency** gives the client a clear signal: "your data is stale, reload and retry"
- **Row lock** guarantees correctness even under extreme concurrent load
- Together they handle both the "normal contention" case (user took too long) and the "exact simultaneous request" case (stress test)

---

## 3. The Concurrency-Safe Transition (Already in Items Service)

This was implemented in Guide 04's `transition()` method. Here's the critical section annotated:

```typescript
async transition(itemId: string, dto: TransitionItemDto, actor: { id: string; role: string }) {
  return this.prisma.$transaction(async (tx) => {
    // LAYER 2: Pessimistic lock — blocks other transactions from reading this row
    const items = await tx.$queryRaw<any[]>`
      SELECT * FROM workflow_items WHERE id = ${itemId}::uuid FOR UPDATE
    `;

    if (items.length === 0) {
      throw new NotFoundException(`Workflow item ${itemId} not found`);
    }

    const item = items[0];

    // LAYER 1: Optimistic concurrency — rejects stale requests
    if (item.version !== dto.version) {
      throw new ConflictException({
        error: 'VERSION_CONFLICT',
        message: 'This item has been modified by another user',
        currentVersion: item.version,
        yourVersion: dto.version,
      });
    }

    // ... validate transition, check permissions ...

    // Atomic update: stage + version bump in one statement
    await tx.workflowItem.update({
      where: { id: itemId },
      data: {
        currentStageId: dto.toStageId,
        version: { increment: 1 },
      },
    });

    // ... record audit event, queue notifications ...
  });
}
```

---

## 4. Concurrency Stress Test — 20+ Simultaneous Transitions

```typescript
// test/concurrency-transitions.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Concurrency Safety — Stage Transitions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let tokens: string[] = [];
  let templateId: string;
  let reviewStageId: string;

  const NUM_CONCURRENT_USERS = 25; // Assessment requires at least 20

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Clean database
    await prisma.notificationOutbox.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.workflowItemComment.deleteMany();
    await prisma.workflowItemAssignment.deleteMany();
    await prisma.documentAttachment.deleteMany();
    await prisma.workflowItem.deleteMany();
    await prisma.transitionPermission.deleteMany();
    await prisma.stageTransition.deleteMany();
    await prisma.templateStage.deleteMany();
    await prisma.workflowTemplate.deleteMany();
    await prisma.user.deleteMany();

    // Create admin
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'admin@stress.com', name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    // Create 25 users
    for (let i = 0; i < NUM_CONCURRENT_USERS; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: `user${i}@stress.com`,
          name: `Stress User ${i}`,
          password: 'pass12345',
        });
      tokens.push(res.body.accessToken);
    }

    // Create a template: Draft → Review (open to all users)
    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Concurrency Test Template',
        stages: [
          { name: 'Draft', isStart: true, position: 0 },
          { name: 'Review', position: 1 },
          { name: 'Done', isFinal: true, position: 2 },
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

  it(`should allow exactly 1 transition when ${NUM_CONCURRENT_USERS} users attempt simultaneously`, async () => {
    // Create a workflow item in Draft stage
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .send({ templateId, title: 'Race Condition Test' });

    expect(createRes.status).toBe(201);
    const itemId = createRes.body.id;
    const version = createRes.body.version; // All users will use this same version

    // Fire all 25 transitions SIMULTANEOUSLY
    const results = await Promise.allSettled(
      tokens.map((token) =>
        request(app.getHttpServer())
          .post(`/api/items/${itemId}/transitions`)
          .set('Authorization', `Bearer ${token}`)
          .send({ toStageId: reviewStageId, version })
      ),
    );

    // Analyze results
    const successes = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 200,
    );
    const conflicts = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 409,
    );
    const badRequests = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 400,
    );

    console.log(`\n=== Concurrency Stress Test Results ===`);
    console.log(`Total requests:  ${NUM_CONCURRENT_USERS}`);
    console.log(`Successes:       ${successes.length}`);
    console.log(`Conflicts (409): ${conflicts.length}`);
    console.log(`Bad requests:    ${badRequests.length}`);
    console.log(`=======================================\n`);

    // CRITICAL ASSERTIONS:
    // 1. Exactly ONE transition succeeded
    expect(successes.length).toBe(1);

    // 2. All others got conflict or bad request (not server errors)
    expect(conflicts.length + badRequests.length).toBe(NUM_CONCURRENT_USERS - 1);

    // 3. The item is now in "Review" stage (correct state)
    const finalItem = await prisma.workflowItem.findUnique({
      where: { id: itemId },
      include: { currentStage: true },
    });
    expect(finalItem!.currentStage.name).toBe('Review');

    // 4. Version was incremented exactly once
    expect(finalItem!.version).toBe(version + 1);

    // 5. Exactly ONE audit event of type STAGE_TRANSITION exists
    const transitionEvents = await prisma.auditEvent.findMany({
      where: { itemId, eventType: 'STAGE_TRANSITION' },
    });
    expect(transitionEvents.length).toBe(1);

    // 6. No duplicate transitions, no corrupted state
    // (If there were duplicates, the version or event count would be wrong)
  });

  it('should handle sequential transitions correctly after a conflict', async () => {
    // Create an item
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .send({ templateId, title: 'Sequential After Conflict' });

    const itemId = createRes.body.id;

    // First transition: Draft → Review (should succeed)
    const firstRes = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${tokens[0]}`)
      .send({ toStageId: reviewStageId, version: 1 });
    
    expect(firstRes.status).toBe(200);

    // Second attempt with stale version (should fail with 409)
    const staleRes = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/transitions`)
      .set('Authorization', `Bearer ${tokens[1]}`)
      .send({ toStageId: reviewStageId, version: 1 }); // stale version!

    expect(staleRes.status).toBe(409);
    expect(staleRes.body.error).toBe('VERSION_CONFLICT');
    expect(staleRes.body.currentVersion).toBe(2);
  });
});
```

---

## 5. Field Edit Concurrency Test

```typescript
// test/concurrency-field-edits.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Concurrency Safety — Field Edits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let aliceToken: string;
  let bobToken: string;
  let templateId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Setup users
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'admin@field.com', name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const aliceRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'alice@field.com', name: 'Alice', password: 'pass12345' });
    aliceToken = aliceRes.body.accessToken;

    const bobRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'bob@field.com', name: 'Bob', password: 'pass12345' });
    bobToken = bobRes.body.accessToken;

    // Create template
    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Field Edit Test',
        stages: [
          { name: 'Open', isStart: true },
          { name: 'Closed', isFinal: true },
        ],
        transitions: [
          { fromStageName: 'Open', toStageName: 'Closed', name: 'Close' },
        ],
      });
    templateId = templateRes.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should detect version conflict when two users edit the same field concurrently', async () => {
    // Create item
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        templateId,
        title: 'Original Title',
        priority: 'LOW',
      });

    const itemId = createRes.body.id;
    const initialVersion = createRes.body.version;

    // Both Alice and Bob load the item (both see version 1)
    // Alice edits the title
    // Bob edits the priority
    // Both send version 1

    const [aliceResult, bobResult] = await Promise.allSettled([
      request(app.getHttpServer())
        .patch(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ title: 'Alice Title', version: initialVersion }),
      request(app.getHttpServer())
        .patch(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ priority: 'URGENT', version: initialVersion }),
    ]);

    // Exactly one should succeed, one should get 409
    const responses = [
      aliceResult.status === 'fulfilled' ? aliceResult.value : null,
      bobResult.status === 'fulfilled' ? bobResult.value : null,
    ].filter(Boolean);

    const successes = responses.filter((r) => r!.status === 200);
    const conflicts = responses.filter((r) => r!.status === 409);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(1);

    // Verify the conflict response has useful information
    const conflictResponse = conflicts[0]!.body;
    expect(conflictResponse.error).toBe('VERSION_CONFLICT');
    expect(conflictResponse.currentVersion).toBeDefined();
    expect(conflictResponse.yourVersion).toBe(initialVersion);

    // Verify the item has exactly one change applied (not both, not neither)
    const finalItem = await prisma.workflowItem.findUnique({ where: { id: itemId } });
    expect(finalItem!.version).toBe(initialVersion + 1); // Bumped exactly once

    // The second user can now retry with the correct version
    const retryRes = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ priority: 'URGENT', version: finalItem!.version });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.version).toBe(initialVersion + 2);
  });

  it('should not silently drop edits (the assessment\'s biggest concern)', async () => {
    /**
     * The assessment says:
     * "A clean-looking implementation that silently drops one user's edit
     *  under concurrent load has failed the core test."
     *
     * This test proves we don't do that — we REJECT the second edit with
     * a clear 409, not silently apply it or silently drop it.
     */

    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ templateId, title: 'Silent Drop Test' });

    const itemId = createRes.body.id;

    // Alice edits with version 1
    const aliceEdit = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ title: 'Alice Was Here', version: 1 });

    expect(aliceEdit.status).toBe(200);

    // Bob tries to edit with stale version 1
    const bobEdit = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ title: 'Bob Was Here', version: 1 }); // STALE!

    // Bob's edit must be REJECTED, not silently applied
    expect(bobEdit.status).toBe(409);

    // Alice's edit is preserved
    const finalItem = await prisma.workflowItem.findUnique({ where: { id: itemId } });
    expect(finalItem!.title).toBe('Alice Was Here'); // Not overwritten by Bob
  });

  it('should generate audit events for all successful edits only', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ templateId, title: 'Audit Concurrency Test' });

    const itemId = createRes.body.id;

    // Two concurrent edits
    await Promise.allSettled([
      request(app.getHttpServer())
        .patch(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ title: 'Edit A', version: 1 }),
      request(app.getHttpServer())
        .patch(`/api/items/${itemId}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ title: 'Edit B', version: 1 }),
    ]);

    // Only ONE FIELD_UPDATED event should exist (the successful edit)
    const events = await prisma.auditEvent.findMany({
      where: { itemId, eventType: 'FIELD_UPDATED' },
    });

    expect(events.length).toBe(1); // Not 2, not 0 — exactly 1

    // Verify event sourcing integrity
    const verifyRes = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}/verify`)
      .set('Authorization', `Bearer ${aliceToken}`);

    expect(verifyRes.body.isConsistent).toBe(true);
  });
});
```

---

## 6. Design Trade-off: Why Not Last-Write-Wins?

The assessment explicitly states:
> *"Version-checked optimistic locking with a clear conflict error — last-write-wins is acceptable only if explicitly justified in your docs as an intentional trade-off, not a default."*

We chose **optimistic locking with conflict detection** because:

| Last-Write-Wins | Our Approach (Conflict Detection) |
|---|---|
| ❌ Silently drops one user's edit | ✅ Rejects with 409 and explanation |
| ❌ User doesn't know their edit was lost | ✅ User can reload and retry |
| ❌ Assessment says "failed the core test" | ✅ No silent data loss |
| Simpler to implement | Slightly more complex, but required by assessment |

---

## 7. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 5: 20+ concurrent transitions | `concurrency-transitions.e2e-spec.ts` with 25 simultaneous users |
| Req 5: Exactly one succeeds | Assertions verify exactly 1 success, 24 conflicts |
| Req 5: No corrupted state | Version bump + audit event count verified |
| Req 6: Field edit concurrency | `concurrency-field-edits.e2e-spec.ts` — two users editing same item |
| Req 6: Conflict detection | 409 response with `currentVersion` and `yourVersion` |
| Req 6: Not silently dropping edits | Explicit test named "should not silently drop edits" |
| "Correctness under concurrency is the single biggest signal" | Two-layer defense (optimistic + row lock), comprehensive tests |

---

**Next: [Guide 08 — Crash Recovery →](./08-crash-recovery.md)**
