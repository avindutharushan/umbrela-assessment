import {
  Controller,
  Get,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Audit Trail')
@Controller('audit')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get('items/:itemId')
  @ApiOperation({ summary: 'Get the complete audit trail for a workflow item' })
  getItemAuditTrail(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.auditService.getEventsByItemId(itemId);
  }

  @Get('items/:itemId/reconstruct')
  @ApiOperation({
    summary: 'Reconstruct item state from event history (proves audit log is source of truth)',
  })
  reconstructState(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.auditService.reconstructStateFromEvents(itemId);
  }

  @Get('items/:itemId/verify')
  @ApiOperation({
    summary: 'Verify that materialized state matches reconstructed state (integrity check)',
  })
  verifyIntegrity(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.auditService.verifyStateIntegrity(itemId);
  }
}
