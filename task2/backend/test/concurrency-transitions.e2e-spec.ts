jest.setTimeout(30000);
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
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
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    // Create 25 users
    for (let i = 0; i < NUM_CONCURRENT_USERS; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: `user${i}@9D129041-CF51-4003-BEB2-FE553B8677DE.com`,
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
      (r) => r.status === 'fulfilled' && r.value.status === 201,
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
    
    expect(firstRes.status).toBe(201);

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
