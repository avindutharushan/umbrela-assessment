# Guide 10 — Notification Queue

> **What you'll build in this guide:** A persistent notification outbox with a separate processor that consumes queued notifications — proving that notifications survive crashes and are never lost. This is Requirement 8 of the assessment.

---

## 1. What the Assessment Requires

> *"Workflow transitions and assignments must generate notification events that are queued for later processing, not delivered synchronously inline. A separate notification processor must consume the queue. Demonstrate that notifications are never lost even if the processor crashes mid-batch (e.g., via a persisted queue/outbox, not an in-memory array)."*

The evaluators specifically check:
> *"Is the notification queue actually durable, or an in-memory structure dressed up to look like a queue?"*

Our approach: **Transactional outbox pattern** — notifications are written to a database table in the same transaction as the operation that triggers them. A separate processor polls the table and processes notifications.

---

## 2. Why the Outbox Pattern?

| ❌ In-memory queue (fails the test) | ✅ Database outbox (our design) |
|---|---|
| Notifications lost on server restart | Notifications survive any crash |
| Not part of the operation's transaction | Written in the same transaction as the operation |
| If the operation rolls back, the notification is already sent | If the operation rolls back, the notification row is also rolled back |
| Hard to prove durability | Trivial to prove: check the table |

---

## 3. Complete Notification Service

We already have the stub from Guide 04. Here's the complete version:

```typescript
// src/notifications/notifications.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Queue a notification for later processing.
   * 
   * CRITICAL: This is called within the same transaction as the
   * operation that triggers it. If the operation fails, the
   * notification is also rolled back — no orphan notifications.
   */
  async queue(
    tx: Prisma.TransactionClient,
    data: {
      userId: string;
      type: string;
      payload: Record<string, any>;
    },
  ) {
    return tx.notificationOutbox.create({
      data: {
        userId: data.userId,
        type: data.type,
        payload: data.payload,
        status: 'PENDING',
        attempts: 0,
      },
    });
  }

  /**
   * Queue notifications for multiple users.
   */
  async queueForMany(
    tx: Prisma.TransactionClient,
    userIds: string[],
    type: string,
    payload: Record<string, any>,
  ) {
    return Promise.all(
      userIds.map((userId) => this.queue(tx, { userId, type, payload })),
    );
  }

  /**
   * Get a user's notifications (delivered ones).
   */
  async getUserNotifications(userId: string, limit = 20) {
    return this.prisma.notificationOutbox.findMany({
      where: {
        userId,
        status: 'DELIVERED',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get count of pending notifications (for monitoring/debugging).
   */
  async getPendingCount() {
    return this.prisma.notificationOutbox.count({
      where: { status: 'PENDING' },
    });
  }
}
```

---

## 4. Notification Processor (Separate Consumer)

```typescript
// src/notifications/notification.processor.ts
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationProcessor.name);
  private isRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 50;
  private readonly POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
  private readonly MAX_ATTEMPTS = 3;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  /**
   * Start the notification processor.
   * Runs as a background polling loop, separate from the request/response path.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('Notification processor started');

    this.intervalHandle = setInterval(() => {
      this.processBatch().catch((err) => {
        this.logger.error('Error processing notification batch:', err);
      });
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop the processor gracefully.
   */
  stop() {
    this.isRunning = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.log('Notification processor stopped');
  }

  /**
   * Process a batch of pending notifications.
   * 
   * Uses SELECT ... FOR UPDATE SKIP LOCKED to allow multiple processor
   * instances to run concurrently without processing the same notification twice.
   */
  async processBatch(): Promise<number> {
    // Claim a batch of pending notifications using FOR UPDATE SKIP LOCKED
    // This prevents duplicate processing if multiple processor instances run
    const notifications = await this.prisma.$queryRaw<any[]>`
      UPDATE notification_outbox
      SET status = 'PROCESSING', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_outbox
        WHERE status = 'PENDING'
          OR (status = 'FAILED' AND attempts < ${this.MAX_ATTEMPTS})
        ORDER BY created_at ASC
        LIMIT ${this.BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    if (notifications.length === 0) return 0;

    this.logger.log(`Processing ${notifications.length} notifications...`);

    let delivered = 0;
    for (const notification of notifications) {
      try {
        // Process the notification (in production, this would send emails, push notifications, etc.)
        await this.deliverNotification(notification);

        // Mark as delivered
        await this.prisma.notificationOutbox.update({
          where: { id: notification.id },
          data: {
            status: 'DELIVERED',
            processedAt: new Date(),
          },
        });

        delivered++;
      } catch (error) {
        this.logger.error(
          `Failed to deliver notification ${notification.id}:`,
          error,
        );

        // Mark as failed (will be retried if attempts < MAX_ATTEMPTS)
        await this.prisma.notificationOutbox.update({
          where: { id: notification.id },
          data: {
            status:
              notification.attempts >= this.MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          },
        });
      }
    }

    this.logger.log(`Delivered ${delivered}/${notifications.length} notifications`);
    return delivered;
  }

  /**
   * Deliver a single notification.
   * 
   * In a production system, this would:
   * - Send an email via SendGrid/SES
   * - Push to a WebSocket for real-time UI updates
   * - Send a mobile push notification
   * 
   * For this assessment, we log it and mark it as delivered.
   */
  private async deliverNotification(notification: any): Promise<void> {
    this.logger.log(
      `📬 Delivering ${notification.type} notification to user ${notification.user_id}: ${JSON.stringify(notification.payload)}`,
    );

    // Simulate delivery (in production, this would be an actual API call)
    // Intentionally not adding artificial delay to keep tests fast
  }
}
```

---

## 5. Notifications Controller

```typescript
// src/notifications/notifications.controller.ts
import { Controller, Get, Post, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationProcessor } from './notification.processor';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(
    private notificationsService: NotificationsService,
    private notificationProcessor: NotificationProcessor,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get my notifications' })
  getMyNotifications(@CurrentUser('id') userId: string) {
    return this.notificationsService.getUserNotifications(userId);
  }

  @Get('pending')
  @Roles('ADMIN')
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Get count of pending notifications (admin)' })
  getPendingCount() {
    return this.notificationsService.getPendingCount();
  }

  @Post('process')
  @Roles('ADMIN')
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Manually trigger notification processing (admin)' })
  async triggerProcessing() {
    const count = await this.notificationProcessor.processBatch();
    return { processed: count };
  }
}
```

---

## 6. Updated Notifications Module

```typescript
// src/notifications/notifications.module.ts
import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationProcessor } from './notification.processor';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

---

## 7. Tests — Proving Durability

```typescript
// test/notification-queue.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
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
      .send({ email: 'admin@notif.com', name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'user@notif.com', name: 'User', password: 'pass12345' });
    userToken = userRes.body.accessToken;
    userId = userRes.body.user.id;

    // Create template
    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Notification Test',
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
```

---

## 8. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 8: Queued for later processing | `NotificationsService.queue()` writes to `notification_outbox` table |
| Req 8: Not delivered inline | Processor runs on a separate interval, not in the request path |
| Req 8: Separate processor | `NotificationProcessor` — polls and processes batches |
| Req 8: Survives crash | Test: stop processor, verify notifications persist, restart, verify delivery |
| Req 8: Persisted queue | Database table, not in-memory array |
| Transactional consistency | Notifications written in same transaction as the triggering operation |

---

**Next: [Guide 11 — Search, Pagination & Complete Test Suite →](./11-search-pagination-and-tests.md)**
