import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export enum AuditEventType {
  ITEM_CREATED = 'ITEM_CREATED',
  STAGE_TRANSITION = 'STAGE_TRANSITION',
  FIELD_UPDATED = 'FIELD_UPDATED',
  ASSIGNMENT_ADDED = 'ASSIGNMENT_ADDED',
  ASSIGNMENT_REMOVED = 'ASSIGNMENT_REMOVED',
  COMMENT_ADDED = 'COMMENT_ADDED',
  ATTACHMENT_ADDED = 'ATTACHMENT_ADDED',
  ATTACHMENT_REMOVED = 'ATTACHMENT_REMOVED',
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /**
   * Record an audit event. This is the ONLY way state changes should be persisted.
   */
  async recordEvent(
    tx: Prisma.TransactionClient,
    data: {
      itemId: string;
      actorId: string;
      eventType: AuditEventType;
      payload: Record<string, any>;
    },
  ) {
    const lastEvent = await tx.auditEvent.findFirst({
      where: { itemId: data.itemId },
      orderBy: { sequenceNum: 'desc' },
      select: { sequenceNum: true },
    });

    const sequenceNum = (lastEvent?.sequenceNum ?? 0) + 1;

    return tx.auditEvent.create({
      data: {
        itemId: data.itemId,
        actorId: data.actorId,
        eventType: data.eventType,
        payload: data.payload,
        sequenceNum,
      },
    });
  }

  /**
   * Get all events for a workflow item, ordered by sequence number.
   */
  async getEventsByItemId(itemId: string) {
    return this.prisma.auditEvent.findMany({
      where: { itemId },
      orderBy: { sequenceNum: 'asc' },
      include: {
        actor: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /**
   * Reconstruct the complete state of a workflow item by replaying all its events.
   * 
   * This is the proof that the audit log is the source of truth:
   * starting from an empty state, we apply each event in sequence and
   * arrive at the current state WITHOUT reading from workflow_items.
   */
  async reconstructStateFromEvents(itemId: string): Promise<ReconstructedState> {
    const events = await this.prisma.auditEvent.findMany({
      where: { itemId },
      orderBy: { sequenceNum: 'asc' },
    });

    if (events.length === 0) {
      throw new NotFoundException(`No events found for item ${itemId}`);
    }

    // Start from empty state
    const state: ReconstructedState = {
      id: itemId,
      templateId: null,
      title: null,
      description: null,
      priority: null,
      currentStageId: null,
      currentStageName: null,
      dueDate: null,
      assignments: new Set<string>(),
      commentCount: 0,
      attachments: new Map<string, { fileName: string; versionNum: number }>(),
      eventCount: events.length,
      lastEventAt: null,
    };

    // Replay each event in order
    for (const event of events) {
      this.applyEvent(state, event);
    }

    return {
      ...state,
      assignments: Array.from(state.assignments as Set<string>),
      attachments: Array.from((state.attachments as Map<string, any>).values()),
    };
  }

  /**
   * Verify that the materialized state in workflow_items matches
   * the state reconstructed from events.
   */
  async verifyStateIntegrity(itemId: string): Promise<IntegrityCheckResult> {
    // Get materialized state
    const materialized = await this.prisma.workflowItem.findUnique({
      where: { id: itemId },
      include: {
        assignments: { select: { userId: true } },
        currentStage: { select: { id: true, name: true } },
      },
    });

    if (!materialized) {
      throw new NotFoundException(`Workflow item ${itemId} not found`);
    }

    // Reconstruct from events
    const reconstructed = await this.reconstructStateFromEvents(itemId);

    // Compare
    const mismatches: string[] = [];

    if (materialized.title !== reconstructed.title) {
      mismatches.push(`title: materialized="${materialized.title}" vs reconstructed="${reconstructed.title}"`);
    }
    if (materialized.description !== reconstructed.description) {
      mismatches.push(`description mismatch`);
    }
    if (materialized.priority !== reconstructed.priority) {
      mismatches.push(`priority: materialized="${materialized.priority}" vs reconstructed="${reconstructed.priority}"`);
    }
    if (materialized.currentStageId !== reconstructed.currentStageId) {
      mismatches.push(`currentStageId: materialized="${materialized.currentStageId}" vs reconstructed="${reconstructed.currentStageId}"`);
    }

    const materializedAssignees = new Set(materialized.assignments.map((a) => a.userId));
    const reconstructedAssignees = new Set(reconstructed.assignments as string[]);

    if (materializedAssignees.size !== reconstructedAssignees.size ||
        ![...materializedAssignees].every((id) => reconstructedAssignees.has(id))) {
      mismatches.push('assignments mismatch');
    }

    return {
      itemId,
      isConsistent: mismatches.length === 0,
      mismatches,
      materializedState: {
        title: materialized.title,
        priority: materialized.priority,
        currentStage: materialized.currentStage?.name,
        assigneeCount: materialized.assignments.length,
      },
      reconstructedState: {
        title: reconstructed.title,
        priority: reconstructed.priority,
        currentStage: reconstructed.currentStageName,
        assigneeCount: (reconstructed.assignments as string[]).length,
      },
      eventCount: reconstructed.eventCount,
    };
  }

  /**
   * Apply a single event to the state accumulator.
   */
  private applyEvent(state: ReconstructedState, event: any): void {
    const payload = event.payload as Record<string, any>;
    state.lastEventAt = event.createdAt;

    switch (event.eventType) {
      case 'ITEM_CREATED':
        state.templateId = payload.templateId;
        state.title = payload.title;
        state.description = payload.description || null;
        state.priority = payload.priority || 'MEDIUM';
        state.currentStageId = payload.startStageId;
        state.currentStageName = payload.startStageName;
        state.dueDate = payload.dueDate || null;
        break;

      case 'STAGE_TRANSITION':
        state.currentStageId = payload.toStageId;
        state.currentStageName = payload.toStageName;
        break;

      case 'FIELD_UPDATED':
        if (payload.field === 'title') state.title = payload.newValue;
        if (payload.field === 'description') state.description = payload.newValue;
        if (payload.field === 'priority') state.priority = payload.newValue;
        if (payload.field === 'dueDate') state.dueDate = payload.newValue;
        break;

      case 'ASSIGNMENT_ADDED':
        (state.assignments as Set<string>).add(payload.userId);
        break;

      case 'ASSIGNMENT_REMOVED':
        (state.assignments as Set<string>).delete(payload.userId);
        break;

      case 'COMMENT_ADDED':
        state.commentCount++;
        break;

      case 'ATTACHMENT_ADDED':
        (state.attachments as Map<string, any>).set(payload.attachmentId, {
          fileName: payload.fileName,
          versionNum: payload.versionNum,
        });
        break;

      case 'ATTACHMENT_REMOVED':
        (state.attachments as Map<string, any>).delete(payload.attachmentId);
        break;
    }
  }
}

export interface ReconstructedState {
  id: string;
  templateId: string | null;
  title: string | null;
  description: string | null;
  priority: string | null;
  currentStageId: string | null;
  currentStageName: string | null;
  dueDate: string | null;
  assignments: Set<string> | string[];
  commentCount: number;
  attachments: Map<string, any> | any[];
  eventCount: number;
  lastEventAt: Date | null;
}

export interface IntegrityCheckResult {
  itemId: string;
  isConsistent: boolean;
  mismatches: string[];
  materializedState: Record<string, any>;
  reconstructedState: Record<string, any>;
  eventCount: number;
}
