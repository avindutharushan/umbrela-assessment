import { Controller, Post, Param, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReconcileService } from './reconcile.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Crash Recovery')
@Controller('reconcile')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ReconcileController {
  constructor(private reconcileService: ReconcileService) {}

  @Post('items/:itemId')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Reconcile a single item from audit events (admin only)' })
  reconcileItem(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.reconcileService.reconcileItem(itemId);
  }

  @Post('all')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Reconcile all items from audit events (admin only)' })
  reconcileAll() {
    return this.reconcileService.reconcileAll();
  }
}
