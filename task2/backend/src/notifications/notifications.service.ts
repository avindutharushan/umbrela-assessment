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
