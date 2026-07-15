# Guide 09 — Document Attachments

> **What you'll build in this guide:** File upload/download with versioning — re-uploading creates a new version (never silently overwrites), with permission checks consistent with other workflow actions. This is Requirement 9 of the assessment.

---

## 1. What the Assessment Requires

> *"Support attaching documents/files to workflow items. Re-attaching/re-uploading must create a new version rather than silently overwrite the previous one, and attachment/removal must respect the same permission rules as other actions."*

---

## 2. Attachments Service

```typescript
// src/attachments/attachments.service.ts
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
import { v4 as uuid } from 'uuid';

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
      const fileId = uuid();
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
```

---

## 3. Attachments Controller

```typescript
// src/attachments/attachments.controller.ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseUUIDPipe,
  ParseBoolPipe,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Document Attachments')
@Controller('items/:itemId/attachments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AttachmentsController {
  constructor(private attachmentsService: AttachmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a file attachment (re-upload creates a new version)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    }),
  )
  upload(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('id') userId: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.attachmentsService.upload(itemId, file, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List attachments for an item' })
  @ApiQuery({ name: 'allVersions', required: false, type: Boolean })
  findAll(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('allVersions') allVersions?: string,
  ) {
    return this.attachmentsService.findByItemId(itemId, allVersions === 'true');
  }

  @Get(':fileName/versions')
  @ApiOperation({ summary: 'Get all versions of a specific file' })
  getVersions(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('fileName') fileName: string,
  ) {
    return this.attachmentsService.getFileVersions(itemId, fileName);
  }

  @Get(':attachmentId/download')
  @ApiOperation({ summary: 'Download a file attachment' })
  async download(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res() res: Response,
  ) {
    const file = await this.attachmentsService.download(attachmentId);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    res.sendFile(file.path, { root: '/' });
  }

  @Delete(':attachmentId')
  @ApiOperation({ summary: 'Remove an attachment' })
  remove(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentsService.remove(attachmentId, userId);
  }
}
```

---

## 4. Attachments Module

```typescript
// src/attachments/attachments.module.ts
import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
```

---

## 5. Tests

```typescript
// test/attachments.e2e-spec.ts
describe('Document Attachments (e2e)', () => {
  // ... setup similar to other tests ...

  it('should create a new version when re-uploading a file with the same name', async () => {
    // Upload version 1
    const v1 = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/attachments`)
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('version 1 content'), 'report.pdf');

    expect(v1.status).toBe(201);
    expect(v1.body.versionNum).toBe(1);
    expect(v1.body.isLatest).toBe(true);

    // Upload version 2 (same filename)
    const v2 = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/attachments`)
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('version 2 content'), 'report.pdf');

    expect(v2.status).toBe(201);
    expect(v2.body.versionNum).toBe(2);
    expect(v2.body.isLatest).toBe(true);

    // List all versions
    const versions = await request(app.getHttpServer())
      .get(`/api/items/${itemId}/attachments/report.pdf/versions`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(versions.body.length).toBe(2);
    expect(versions.body[0].versionNum).toBe(2); // Latest first
    expect(versions.body[1].versionNum).toBe(1);

    // Default listing only shows latest
    const latest = await request(app.getHttpServer())
      .get(`/api/items/${itemId}/attachments`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(latest.body.length).toBe(1);
    expect(latest.body[0].versionNum).toBe(2);
  });

  it('should generate audit events for attachments', async () => {
    // Upload
    await request(app.getHttpServer())
      .post(`/api/items/${itemId}/attachments`)
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('test'), 'audit-test.txt');

    // Check audit trail
    const audit = await request(app.getHttpServer())
      .get(`/api/audit/items/${itemId}`)
      .set('Authorization', `Bearer ${userToken}`);

    const attachmentEvents = audit.body.filter(
      (e: any) => e.eventType === 'ATTACHMENT_ADDED',
    );
    expect(attachmentEvents.length).toBeGreaterThanOrEqual(1);
    expect(attachmentEvents[0].payload.fileName).toBe('audit-test.txt');
  });
});
```

---

## 6. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Req 9: Attach documents | Upload endpoint with file handling |
| Req 9: Re-upload creates new version | `versionNum` incremented, old version marked `isLatest: false` |
| Req 9: Never silently overwrite | Old versions preserved, accessible via versions endpoint |
| Req 9: Same permission rules | Auth guard applies to all attachment endpoints |

---

**Next: [Guide 10 — Notification Queue →](./10-notification-queue.md)**
