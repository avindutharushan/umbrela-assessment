import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TemplatesModule } from './templates/templates.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ItemsModule } from './items/items.module';
import { TransitionsModule } from './transitions/transitions.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    AuthModule,
    TemplatesModule,
    AuditModule,
    NotificationsModule,
    TransitionsModule,
    ItemsModule,
    AttachmentsModule,
    SearchModule,
  ],
})
export class AppModule {}
