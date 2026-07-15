import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { ReconcileService } from './reconcile.service';
import { ReconcileController } from './reconcile.controller';

@Module({
  controllers: [AuditController, ReconcileController],
  providers: [AuditService, ReconcileService],
  exports: [AuditService, ReconcileService],
})
export class AuditModule {}
