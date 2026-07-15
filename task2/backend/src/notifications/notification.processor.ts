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
