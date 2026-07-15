import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Search & Pagination (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  let userId: string;
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

    // Setup
    const adminRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `admin_${Date.now()}@search.com`, name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: `user_${Date.now()}@search.com`, name: 'User', password: 'pass12345' });
    userToken = userRes.body.accessToken;
    userId = userRes.body.user.id;

    const templateRes = await request(app.getHttpServer())
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Search Test',
        stages: [
          { name: 'Open', isStart: true },
          { name: 'Closed', isFinal: true },
        ],
        transitions: [
          { fromStageName: 'Open', toStageName: 'Closed', name: 'Close' },
        ],
      });
    templateId = templateRes.body.id;

    // Create 15 test items with varying properties
    for (let i = 0; i < 15; i++) {
      await request(app.getHttpServer())
        .post('/api/items')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          templateId,
          title: `Search Item ${i}`,
          priority: i < 5 ? 'LOW' : i < 10 ? 'MEDIUM' : 'HIGH',
          assigneeIds: i % 2 === 0 ? [userId] : [],
        });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('should paginate results', async () => {
    const page1 = await request(app.getHttpServer())
      .get('/api/search/items?page=1&limit=5')
      .set('Authorization', `Bearer ${userToken}`);

    expect(page1.status).toBe(200);
    expect(page1.body.data.length).toBe(5);
    expect(page1.body.meta.total).toBe(15);
    expect(page1.body.meta.totalPages).toBe(3);
    expect(page1.body.meta.hasNextPage).toBe(true);
    expect(page1.body.meta.hasPreviousPage).toBe(false);

    const page2 = await request(app.getHttpServer())
      .get('/api/search/items?page=2&limit=5')
      .set('Authorization', `Bearer ${userToken}`);

    expect(page2.body.data.length).toBe(5);
    expect(page2.body.meta.hasNextPage).toBe(true);
    expect(page2.body.meta.hasPreviousPage).toBe(true);

    const page3 = await request(app.getHttpServer())
      .get('/api/search/items?page=3&limit=5')
      .set('Authorization', `Bearer ${userToken}`);

    expect(page3.body.data.length).toBe(5);
    expect(page3.body.meta.hasNextPage).toBe(false);

    // Verify no duplicates across pages
    const allIds = [
      ...page1.body.data.map((d: any) => d.id),
      ...page2.body.data.map((d: any) => d.id),
      ...page3.body.data.map((d: any) => d.id),
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(15);
  });

  it('should filter by priority', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/search/items?priority=HIGH')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
    res.body.data.forEach((item: any) => {
      expect(item.priority).toBe('HIGH');
    });
  });

  it('should filter by assigned user', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/search/items?assignedTo=${userId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(8); // Items 0,2,4,6,8,10,12,14
    res.body.data.forEach((item: any) => {
      expect(item.assignments.some((a: any) => a.user.id === userId)).toBe(true);
    });
  });

  it('should filter by template (workflow type)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/search/items?templateId=${templateId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(15);
  });

  it('should filter by date range', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const res = await request(app.getHttpServer())
      .get(`/api/search/items?createdAfter=${yesterday.toISOString()}&createdBefore=${tomorrow.toISOString()}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(15);
  });

  it('should search by title', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/search/items?search=Item 1')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    // Should match "Search Item 1", "Search Item 10", "Search Item 11", etc.
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    res.body.data.forEach((item: any) => {
      expect(item.title.toLowerCase()).toContain('item 1');
    });
  });

  it('should combine multiple filters', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/search/items?priority=HIGH&assignedTo=${userId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    res.body.data.forEach((item: any) => {
      expect(item.priority).toBe('HIGH');
      expect(item.assignments.some((a: any) => a.user.id === userId)).toBe(true);
    });
  });

  it('should sort results', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/search/items?sortBy=title&sortOrder=asc&limit=5')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const titles = res.body.data.map((d: any) => d.title);
    const sorted = [...titles].sort();
    expect(titles).toEqual(sorted);
  });
});
