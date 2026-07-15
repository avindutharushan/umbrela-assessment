import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
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
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'User', password: 'pass12345' });
    userToken = userRes.body.accessToken;

    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Crash Test Template',
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
