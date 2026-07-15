import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, AuditEventType } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

@Injectable()
export class AttachmentsService {
  private uploadDir: string;

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private notificationsService: NotificationsService,
  ) {
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
    // Ensure upload directory exists
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /**
   * Upload a file attachment to a workflow item.
   * 
   * If a file with the same name already exists on this item,
   * the new upload becomes a NEW VERSION (versionNum incremented).
   * The old version is preserved but marked as isLatest = false.
   */
  async upload(
    itemId: string,
    file: Express.Multer.File,
    actorId: string,
  ) {
    const item = await this.prisma.workflowItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      throw new NotFoundException(`Workflow item ${itemId} not found`);
    }

    return this.prisma.$transaction(async (tx) => {
      // Check if a file with this name already exists on this item
      const existingLatest = await tx.documentAttachment.findFirst({
        where: {
          itemId,
          fileName: file.originalname,
          isLatest: true,
        },
      });

      let versionNum = 1;

      if (existingLatest) {
        // Mark the old version as not latest
        await tx.documentAttachment.update({
          where: { id: existingLatest.id },
          data: { isLatest: false },
        });
        versionNum = existingLatest.versionNum + 1;
      }

      // Save file to disk with a unique name (prevents collisions)
      const fileId = randomUUID();
      const ext = path.extname(file.originalname);
      const storedName = `${fileId}${ext}`;
      const filePath = path.join(this.uploadDir, storedName);

      fs.writeFileSync(filePath, file.buffer);

      // Create the attachment record
      const attachment = await tx.documentAttachment.create({
        data: {
          itemId,
          uploadedBy: actorId,
          fileName: file.originalname,
          filePath: storedName, // Store relative path
          mimeType: file.mimetype,
          fileSize: file.size,
          versionNum,
          isLatest: true,
        },
      });

      // Record audit event
      await this.auditService.recordEvent(tx, {
        itemId,
        actorId,
        eventType: AuditEventType.ATTACHMENT_ADDED,
        payload: {
          attachmentId: attachment.id,
          fileName: file.originalname,
          versionNum,
          fileSize: file.size,
          mimeType: file.mimetype,
          isNewVersion: versionNum > 1,
        },
      });

      // Notify assigned users
      const assignments = await tx.workflowItemAssignment.findMany({
        where: { itemId },
        select: { userId: true },
      });
      const notifyUserIds = assignments
        .map((a) => a.userId)
        .filter((id) => id !== actorId);

      if (notifyUserIds.length > 0) {
        await this.notificationsService.queueForMany(
          tx,
          notifyUserIds,
          'ATTACHMENT_ADDED',
          {
            itemId,
            fileName: file.originalname,
            versionNum,
            uploadedBy: actorId,
          },
        );
      }

      return attachment;
    });
  }

  /**
   * Get all attachments for a workflow item.
   * By default returns only latest versions; set allVersions=true for full history.
   */
  async findByItemId(itemId: string, allVersions = false) {
    return this.prisma.documentAttachment.findMany({
      where: {
        itemId,
        ...(allVersions ? {} : { isLatest: true }),
      },
      include: {
        uploader: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ fileName: 'asc' }, { versionNum: 'desc' }],
    });
  }

  /**
   * Get all versions of a specific file by name.
   */
  async getFileVersions(itemId: string, fileName: string) {
    return this.prisma.documentAttachment.findMany({
      where: { itemId, fileName },
      include: {
        uploader: { select: { id: true, name: true } },
      },
      orderBy: { versionNum: 'desc' },
    });
  }

  /**
   * Download a file (returns the file path for streaming).
   */
  async download(attachmentId: string) {
    const attachment = await this.prisma.documentAttachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    const fullPath = path.join(this.uploadDir, attachment.filePath);

    if (!fs.existsSync(fullPath)) {
      throw new NotFoundException('File not found on disk');
    }

    return {
      path: fullPath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    };
  }

  /**
   * Remove an attachment (soft — marks as not latest, preserves file).
   * Generates an audit event.
   */
  async remove(attachmentId: string, actorId: string) {
    const attachment = await this.prisma.documentAttachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }

    return this.prisma.$transaction(async (tx) => {
      // Mark as removed (not latest)
      await tx.documentAttachment.update({
        where: { id: attachmentId },
        data: { isLatest: false },
      });

      // Find the previous version and make it latest (if any)
      const previousVersion = await tx.documentAttachment.findFirst({
        where: {
          itemId: attachment.itemId,
          fileName: attachment.fileName,
          versionNum: { lt: attachment.versionNum },
        },
        orderBy: { versionNum: 'desc' },
      });

      if (previousVersion) {
        await tx.documentAttachment.update({
          where: { id: previousVersion.id },
          data: { isLatest: true },
        });
      }

      // Audit event
      await this.auditService.recordEvent(tx, {
        itemId: attachment.itemId,
        actorId,
        eventType: AuditEventType.ATTACHMENT_REMOVED,
        payload: {
          attachmentId: attachment.id,
          fileName: attachment.fileName,
          versionNum: attachment.versionNum,
        },
      });

      return { message: 'Attachment removed', attachmentId };
    });
  }
}
