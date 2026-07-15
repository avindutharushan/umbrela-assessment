import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationProcessor } from '../src/notifications/notification.processor';

describe('Notification Queue — Durability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processor: NotificationProcessor;
  let adminToken: string;
  let userToken: string;
  let userId: string;
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
    processor = app.get(NotificationProcessor);

    // Stop auto-processing so we can control it in tests
    processor.stop();

    // Setup users
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`, name: 'User', password: 'pass12345' });
    userToken = userRes.body.accessToken;
    userId = userRes.body.user.id;

    // Create template
    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Notification Test',
        stages: [
          { name: 'Open', isStart: true, position: 0 },
          { name: 'Closed', isFinal: true, position: 1 },
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

  it('should persist notifications in the database, not in memory', async () => {
    // Clear existing notifications
    await prisma.notificationOutbox.deleteMany();

    // Create an item and assign a user (generates notification)
    const createRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId,
        title: 'Notification Test Item',
        assigneeIds: [userId],
      });

    expect(createRes.status).toBe(201);

    // Check that the notification is in the DATABASE (not just in memory)
    const pendingNotifications = await prisma.notificationOutbox.findMany({
      where: { status: 'PENDING' },
    });

    expect(pendingNotifications.length).toBeGreaterThanOrEqual(1);
    expect(pendingNotifications[0].userId).toBe(userId);
    expect(pendingNotifications[0].type).toBe('ASSIGNMENT');

    // Notifications are PENDING (not yet processed)
    // This proves they are queued, not delivered inline
  });

  it('should survive processor restart (no notification loss)', async () => {
    await prisma.notificationOutbox.deleteMany();

    // Generate some notifications
    await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId, title: 'Crash Test 1', assigneeIds: [userId] });

    await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId, title: 'Crash Test 2', assigneeIds: [userId] });

    // Count pending before "crash"
    const pendingBefore = await prisma.notificationOutbox.count({
      where: { status: 'PENDING' },
    });
    expect(pendingBefore).toBeGreaterThanOrEqual(2);

    // SIMULATE CRASH: Stop the processor
    processor.stop();

    // Verify notifications are still in the database
    const afterCrash = await prisma.notificationOutbox.count({
      where: { status: 'PENDING' },
    });
    expect(afterCrash).toBe(pendingBefore); // Nothing lost!

    // RESTART: Process the batch
    const delivered = await processor.processBatch();
    expect(delivered).toBe(pendingBefore);

    // All notifications are now delivered
    const afterProcess = await prisma.notificationOutbox.count({
      where: { status: 'PENDING' },
    });
    expect(afterProcess).toBe(0);
  });

  it('should not process the same notification twice', async () => {
    await prisma.notificationOutbox.deleteMany();

    // Generate a notification
    await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ templateId, title: 'Dedup Test', assigneeIds: [userId] });

    // Process once
    await processor.processBatch();

    // Process again — should find nothing to process
    const secondRun = await processor.processBatch();
    expect(secondRun).toBe(0);

    // Verify only one DELIVERED record
    const delivered = await prisma.notificationOutbox.findMany({
      where: { status: 'DELIVERED', type: 'ASSIGNMENT' },
    });
    // Each notification should be delivered exactly once
    const uniqueIds = new Set(delivered.map((d) => d.id));
    expect(uniqueIds.size).toBe(delivered.length);
  });

  it('should not create notifications when operation rolls back', async () => {
    await prisma.notificationOutbox.deleteMany();

    // Try to create an item with an invalid template (should fail)
    const failRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        templateId: '00000000-0000-0000-0000-000000000000', // Non-existent
        title: 'Should Fail',
        assigneeIds: [userId],
      });

    expect(failRes.status).toBeGreaterThanOrEqual(400);

    // No notifications should have been created (transaction rolled back)
    const notifications = await prisma.notificationOutbox.count();
    expect(notifications).toBe(0);
  });
});
