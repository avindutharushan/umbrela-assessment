import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
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
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Clean database
    await prisma.notificationOutbox.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.workflowItemAssignment.deleteMany();
    await prisma.documentAttachment.deleteMany();
    await prisma.workflowItem.deleteMany();
    await prisma.transitionPermission.deleteMany();
    await prisma.stageTransition.deleteMany();
    await prisma.templateStage.deleteMany();
    await prisma.workflowTemplate.deleteMany();
    await prisma.user.deleteMany();

    // Create users and get tokens
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Admin', password: 'password123', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'User', password: 'password123' });
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
