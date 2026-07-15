import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';

describe('Document Attachments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let itemId: string;
  let templateId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `attach_${Date.now()}@test.com`, name: 'Attach User', password: 'password123', role: 'ADMIN' });
    console.log('User Register Attachments:', userRes.status, userRes.body); userToken = userRes.body.accessToken;

    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'Attachment Test Template',
        stages: [{ name: 'Draft', isStart: true }, { name: 'Done', isFinal: true }],
        transitions: [{ fromStageName: 'Draft', toStageName: 'Done', name: 'Finish' }],
      });
    templateId = templateRes.body.id;

    const itemRes = await request(app.getHttpServer())
      .post('/api/items')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ templateId, title: 'Attachment Test Item' });
    console.log('Item Create Attachments:', itemRes.status, itemRes.body); itemId = itemRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    // Clean up uploads directory optionally
  });

  it('should create a new version when re-uploading a file with the same name', async () => {
    // Upload version 1
    const v1 = await request(app.getHttpServer())
      .post(`/api/items/${itemId}/attachments`)
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('version 1 content'), 'report.pdf');

    console.log('Upload v1:', v1.status, v1.body); expect(v1.status).toBe(201);
    expect(v1.body.versionNum).toBe(1);
    expect(v1.body.isLatest).toBe(true);
    const v1Id = v1.body.id;

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

    // Downloading version 1 should still work
    const downloadRes = await request(app.getHttpServer())
      .get(`/api/items/${itemId}/attachments/${v1Id}/download`)
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.body.toString()).toBe('version 1 content');
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
    
    // Find the exact one
    const ourEvent = attachmentEvents.find((e: any) => e.payload.fileName === 'audit-test.txt');
    expect(ourEvent).toBeDefined();
    expect(ourEvent.payload.isNewVersion).toBe(false);
  });
});
