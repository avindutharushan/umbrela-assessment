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
