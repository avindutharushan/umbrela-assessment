import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
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
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const aliceRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Alice', password: 'pass12345' });
    aliceToken = aliceRes.body.accessToken;

    const bobRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Bob', password: 'pass12345' });
    bobToken = bobRes.body.accessToken;

    // Create template
    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Field Edit Test',
        stages: [
          { name: 'Open', isStart: true, position: 0 },
          { name: 'Closed', isFinal: true, position: 1 },
        ],
        transitions: [
          { fromStageName: 'Open', toStageName: 'Closed', name: 'Close', permissions: [] },
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
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ templateId, title: 'Silent Drop Test' });

    const itemId = createRes.body.id;
    const initialVersion = createRes.body.version;

    // Alice edits with the correct initial version
    const aliceEdit = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ title: 'Alice Was Here', version: initialVersion });

    console.log('Alice Edit:', aliceEdit.status, aliceEdit.body); expect(aliceEdit.status).toBe(200);

    // Bob tries to edit with the stale initial version
    const bobEdit = await request(app.getHttpServer())
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ title: 'Bob Was Here', version: initialVersion }); // STALE!

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
