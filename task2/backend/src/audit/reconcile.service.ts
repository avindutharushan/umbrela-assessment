import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

export interface ReconcileResult {
  itemId: string;
  wasInconsistent: boolean;
  changes: string[];
  previousState: Record<string, any>;
  reconciledState: Record<string, any>;
  eventsReplayed: number;
}

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
  ) {}

  /**
   * Reconcile a single workflow item by rebuilding its materialized state
   * from the immutable audit event history.
   * 
   * This is the crash recovery mechanism: if a server crash occurs AFTER
   * an audit event is written but BEFORE the materialized state is updated,
   * calling reconcile() will bring the materialized state back into sync.
   * 
   * Strategy: COMPLETE FORWARD — we treat the audit log as truth and
   * rebuild the cached state to match it.
   */
  async reconcileItem(itemId: string): Promise<ReconcileResult> {
    this.logger.log(`Reconciling item ${itemId}...`);

    // 1. Reconstruct the "should-be" state from events
    const reconstructed = await this.auditService.reconstructStateFromEvents(itemId);

    // 2. Read the current materialized state
    const current = await this.prisma.workflowItem.findUnique({
      where: { id: itemId },
      include: {
        assignments: { select: { userId: true } },
        currentStage: { select: { id: true, name: true } },
      },
    });

    if (!current) {
      // Edge case: audit events exist but the item row doesn't.
      // This means the crash happened after the audit event but before the item was created.
      // Complete forward: create the item from the ITEM_CREATED event.
      return this.reconcileFromScratch(itemId, reconstructed);
    }

    // 3. Compare and fix
    const changes: string[] = [];
    const updateData: Record<string, any> = {};

    if (current.title !== reconstructed.title) {
      changes.push(`title: "${current.title}" → "${reconstructed.title}"`);
      updateData.title = reconstructed.title;
    }

    if (current.description !== reconstructed.description) {
      changes.push(`description: updated`);
      updateData.description = reconstructed.description;
    }

    if (current.priority !== reconstructed.priority) {
      changes.push(`priority: "${current.priority}" → "${reconstructed.priority}"`);
      updateData.priority = reconstructed.priority;
    }

    if (current.currentStageId !== reconstructed.currentStageId) {
      changes.push(
        `currentStage: "${current.currentStage?.name}" → "${reconstructed.currentStageName}"`,
      );
      updateData.currentStageId = reconstructed.currentStageId;
    }

    // Reconcile assignments
    const currentAssignees = new Set(current.assignments.map((a) => a.userId));
    const targetAssignees = new Set(reconstructed.assignments as string[]);

    const toAdd = [...targetAssignees].filter((id) => !currentAssignees.has(id));
    const toRemove = [...currentAssignees].filter((id) => !targetAssignees.has(id));

    if (toAdd.length > 0 || toRemove.length > 0) {
      changes.push(`assignments: +${toAdd.length} -${toRemove.length}`);
    }

    const wasInconsistent = changes.length > 0;

    if (wasInconsistent) {
      this.logger.warn(`Item ${itemId} is INCONSISTENT. Applying ${changes.length} fixes...`);

      await this.prisma.$transaction(async (tx) => {
        // Update the item
        if (Object.keys(updateData).length > 0) {
          await tx.workflowItem.update({
            where: { id: itemId },
            data: updateData,
          });
        }

        // Fix assignments
        for (const userId of toAdd) {
          await tx.workflowItemAssignment.create({
            data: { itemId, userId },
          }).catch(() => {
            // Assignment might already exist — ignore
          });
        }

        for (const userId of toRemove) {
          await tx.workflowItemAssignment.deleteMany({
            where: { itemId, userId },
          });
        }
      });

      this.logger.log(`Item ${itemId} reconciled successfully`);
    } else {
      this.logger.log(`Item ${itemId} is consistent — no changes needed`);
    }

    return {
      itemId,
      wasInconsistent,
      changes,
      previousState: {
        title: current.title,
        priority: current.priority,
        currentStage: current.currentStage?.name,
        assigneeCount: current.assignments.length,
      },
      reconciledState: {
        title: reconstructed.title,
        priority: reconstructed.priority,
        currentStage: reconstructed.currentStageName,
        assigneeCount: (reconstructed.assignments as string[]).length,
      },
      eventsReplayed: reconstructed.eventCount,
    };
  }

  /**
   * Reconcile ALL items — useful for startup/health checks.
   */
  async reconcileAll(): Promise<{
    total: number;
    inconsistent: number;
    results: ReconcileResult[];
  }> {
    this.logger.log('Starting full reconciliation...');

    const items = await this.prisma.workflowItem.findMany({
      select: { id: true },
    });

    const results: ReconcileResult[] = [];
    for (const item of items) {
      try {
        const result = await this.reconcileItem(item.id);
        results.push(result);
      } catch (error) {
        this.logger.error(`Failed to reconcile item ${item.id}:`, error);
      }
    }

    const inconsistent = results.filter((r) => r.wasInconsistent).length;

    this.logger.log(
      `Reconciliation complete. ${items.length} items checked, ${inconsistent} fixed.`,
    );

    return {
      total: items.length,
      inconsistent,
      results: results.filter((r) => r.wasInconsistent), // Only return the ones that had issues
    };
  }

  /**
   * Handle the edge case where audit events exist but the item row doesn't.
   */
  private async reconcileFromScratch(
    itemId: string,
    reconstructed: any,
  ): Promise<ReconcileResult> {
    this.logger.warn(`Item ${itemId} has events but no row — creating from events...`);

    await this.prisma.$transaction(async (tx) => {
      await tx.workflowItem.create({
        data: {
          id: itemId,
          templateId: reconstructed.templateId,
          title: reconstructed.title || 'Recovered Item',
          description: reconstructed.description,
          priority: reconstructed.priority || 'MEDIUM',
          currentStageId: reconstructed.currentStageId,
          dueDate: reconstructed.dueDate ? new Date(reconstructed.dueDate) : null,
        },
      });

      for (const userId of reconstructed.assignments as string[]) {
        await tx.workflowItemAssignment.create({
          data: { itemId, userId },
        }).catch(() => {});
      }
    });

    return {
      itemId,
      wasInconsistent: true,
      changes: ['Created item row from event history (crash during creation)'],
      previousState: { exists: false },
      reconciledState: {
        title: reconstructed.title,
        priority: reconstructed.priority,
        currentStage: reconstructed.currentStageName,
      },
      eventsReplayed: reconstructed.eventCount,
    };
  }
}
