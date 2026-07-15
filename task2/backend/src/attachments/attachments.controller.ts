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
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
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
    res.sendFile(file.path, { root: process.cwd() });
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
