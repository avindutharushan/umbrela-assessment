# Guide 11 — Search, Pagination & Complete Test Suite

> **What you'll build in this guide:** Search and filtering for workflow items (by state, assigned user, workflow type, date range) with pagination, plus the complete test suite covering all mandatory test types from the assessment. This covers Requirements 10 and 11.

---

## 1. What the Assessment Requires

### Requirement 10:
> *"Filter workflow items by state, assigned user, workflow type, and creation date range, with pagination for larger result sets."*

### Requirement 11:
> *"Tests (mandatory, not optional): Unit tests, integration tests, the concurrency stress tests from #5 and #6, permission validation tests, invalid-transition rejection tests, crash recovery/event-replay tests, notification processing tests, and version-conflict detection tests."*

---

## 2. Search & Pagination Service

```typescript
// src/search/search.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface SearchFilters {
  // Filter by workflow type (template)
  templateId?: string;
  
  // Filter by current stage
  stageId?: string;
  stageName?: string;
  
  // Filter by assigned user
  assignedUserId?: string;
  
  // Filter by priority
  priority?: string;
  
  // Filter by creation date range
  createdAfter?: string;
  createdBefore?: string;
  
  // Text search on title
  search?: string;
  
  // Pagination
  page?: number;
  limit?: number;
  
  // Sorting
  sortBy?: 'createdAt' | 'updatedAt' | 'priority' | 'title';
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  filters: Record<string, any>;
}

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  async searchItems(filters: SearchFilters): Promise<PaginatedResult<any>> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100); // Cap at 100
    const skip = (page - 1) * limit;

    // Build the WHERE clause dynamically
    const where: Prisma.WorkflowItemWhereInput = {};

    // Filter by template (workflow type)
    if (filters.templateId) {
      where.templateId = filters.templateId;
    }

    // Filter by current stage (ID or name)
    if (filters.stageId) {
      where.currentStageId = filters.stageId;
    }
    if (filters.stageName) {
      where.currentStage = { name: { contains: filters.stageName, mode: 'insensitive' } };
    }

    // Filter by assigned user
    if (filters.assignedUserId) {
      where.assignments = {
        some: { userId: filters.assignedUserId },
      };
    }

    // Filter by priority
    if (filters.priority) {
      where.priority = filters.priority;
    }

    // Filter by creation date range
    if (filters.createdAfter || filters.createdBefore) {
      where.createdAt = {};
      if (filters.createdAfter) {
        where.createdAt.gte = new Date(filters.createdAfter);
      }
      if (filters.createdBefore) {
        where.createdAt.lte = new Date(filters.createdBefore);
      }
    }

    // Text search on title
    if (filters.search) {
      where.title = { contains: filters.search, mode: 'insensitive' };
    }

    // Sorting
    const orderBy: Prisma.WorkflowItemOrderByWithRelationInput = {};
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'desc';
    orderBy[sortBy] = sortOrder;

    // Execute query with count
    const [items, total] = await Promise.all([
      this.prisma.workflowItem.findMany({
        where,
        include: {
          template: { select: { id: true, name: true } },
          currentStage: { select: { id: true, name: true, isFinal: true } },
          assignments: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
          _count: {
            select: { comments: true, attachments: true, auditEvents: true },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.workflowItem.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
      filters: {
        templateId: filters.templateId,
        stageId: filters.stageId,
        assignedUserId: filters.assignedUserId,
        priority: filters.priority,
        createdAfter: filters.createdAfter,
        createdBefore: filters.createdBefore,
        search: filters.search,
      },
    };
  }
}
```

---

## 3. Search Controller

```typescript
// src/search/search.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Search & Pagination')
@Controller('search/items')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search and filter workflow items with pagination',
  })
  @ApiQuery({ name: 'templateId', required: false, description: 'Filter by workflow type' })
  @ApiQuery({ name: 'stageId', required: false, description: 'Filter by current stage ID' })
  @ApiQuery({ name: 'stageName', required: false, description: 'Filter by current stage name (partial match)' })
  @ApiQuery({ name: 'assignedTo', required: false, description: 'Filter by assigned user ID' })
  @ApiQuery({ name: 'priority', required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @ApiQuery({ name: 'createdAfter', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'createdBefore', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'search', required: false, description: 'Text search on title' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'updatedAt', 'priority', 'title'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  search(
    @Query('templateId') templateId?: string,
    @Query('stageId') stageId?: string,
    @Query('stageName') stageName?: string,
    @Query('assignedTo') assignedUserId?: string,
    @Query('priority') priority?: string,
    @Query('createdAfter') createdAfter?: string,
    @Query('createdBefore') createdBefore?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.searchService.searchItems({
      templateId,
      stageId,
      stageName,
      assignedUserId,
      priority,
      createdAfter,
      createdBefore,
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      sortBy: sortBy as any,
      sortOrder: sortOrder as any,
    });
  }
}
```

---

## 4. Search Module

```typescript
// src/search/search.module.ts
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
```

---

## 5. Final `app.module.ts`

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TemplatesModule } from './templates/templates.module';
import { ItemsModule } from './items/items.module';
import { TransitionsModule } from './transitions/transitions.module';
import { AuditModule } from './audit/audit.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    TemplatesModule,
    ItemsModule,
    TransitionsModule,
    AuditModule,
    AttachmentsModule,
    NotificationsModule,
    SearchModule,
  ],
})
export class AppModule {}
```

---

## 6. Complete Test Suite Overview

The assessment mandates these test types. Here's where each is implemented:

| Test Type | File | Guide |
|-----------|------|-------|
| **Unit tests** (services, policies) | `src/**/*.spec.ts` | Guides 03, 05 |
| **Integration tests** (API endpoints) | `test/audit-event-sourcing.e2e-spec.ts` | Guide 06 |
| **Concurrency stress tests** (transitions) | `test/concurrency-transitions.e2e-spec.ts` | Guide 07 |
| **Concurrency stress tests** (field edits) | `test/concurrency-field-edits.e2e-spec.ts` | Guide 07 |
| **Permission validation tests** | `src/transitions/transition-policy.service.spec.ts` | Guide 05 |
| **Invalid-transition rejection tests** | `src/transitions/transition-policy.service.spec.ts` | Guide 05 |
| **Crash recovery / event-replay tests** | `test/crash-recovery.e2e-spec.ts` | Guide 08 |
| **Notification processing tests** | `test/notification-queue.e2e-spec.ts` | Guide 10 |
| **Version-conflict detection tests** | `test/concurrency-field-edits.e2e-spec.ts` | Guide 07 |

### Search & Pagination Tests

```typescript
// test/search-pagination.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
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
      .send({ email: 'admin@search.com', name: 'Admin', password: 'pass12345', role: 'ADMIN' });
    adminToken = adminRes.body.accessToken;

    const userRes = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'user@search.com', name: 'User', password: 'pass12345' });
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
```

---

## 7. Running All Tests

### Configure Jest for E2E:

```json
// test/jest-e2e.json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  },
  "moduleNameMapper": {
    "^src/(.*)$": "<rootDir>/../src/$1"
  }
}
```

### Add test scripts to `backend/package.json`:

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:e2e": "jest --config ./test/jest-e2e.json --runInBand --forceExit",
    "test:e2e:verbose": "jest --config ./test/jest-e2e.json --runInBand --forceExit --verbose",
    "test:concurrency": "jest --config ./test/jest-e2e.json --testPathPattern=concurrency --runInBand --forceExit",
    "test:all": "npm run test && npm run test:e2e"
  }
}
```

### Run all tests:

```bash
# Start the test database
docker compose up -d postgres-test

# Run unit tests
cd backend
npm run test

# Run E2E tests (uses test database, runs serially)
DATABASE_URL="postgresql://workflowcore:workflowcore_test@localhost:5433/workflowcore_test" npm run test:e2e

# Run only concurrency stress tests
DATABASE_URL="postgresql://workflowcore:workflowcore_test@localhost:5433/workflowcore_test" npm run test:concurrency
```

---

## 8. Test Coverage Matrix

| # | Test Type | File | Assessment Req |
|---|-----------|------|----------------|
| 1 | Unit: Template validation | `templates.service.spec.ts` | Req 1 |
| 2 | Unit: Transition policy | `transition-policy.service.spec.ts` | Req 3, 5 |
| 3 | Integration: Full lifecycle | `audit-event-sourcing.e2e-spec.ts` | Req 2, 4 |
| 4 | Concurrency: 25 simultaneous transitions | `concurrency-transitions.e2e-spec.ts` | Req 5 |
| 5 | Concurrency: Field edit conflicts | `concurrency-field-edits.e2e-spec.ts` | Req 6 |
| 6 | Crash recovery: reconcile() | `crash-recovery.e2e-spec.ts` | Req 7 |
| 7 | Notification: Durability | `notification-queue.e2e-spec.ts` | Req 8 |
| 8 | Attachment: Versioning | `attachments.e2e-spec.ts` | Req 9 |
| 9 | Search: Filtering & pagination | `search-pagination.e2e-spec.ts` | Req 10 |
| 10 | Permission: Role-based rejection | `transition-policy.service.spec.ts` | Req 3 |
| 11 | Invalid transition: Rejection | `transition-policy.service.spec.ts` | Req 3 |
| 12 | Version conflict: Detection | `concurrency-field-edits.e2e-spec.ts` | Req 6 |

---

## 9. Next.js Frontend API Integration

For the Next.js frontend, use these API endpoints in your pages:

```typescript
// frontend/src/lib/api.ts — add these helper functions

// Templates
export const getTemplates = () => api.get('/templates');
export const getTemplate = (id: string) => api.get(`/templates/${id}`);
export const createTemplate = (data: any) => api.post('/templates', data);

// Items
export const getItems = (params?: Record<string, string>) =>
  api.get('/search/items', { params });
export const getItem = (id: string) => api.get(`/items/${id}`);
export const createItem = (data: any) => api.post('/items', data);
export const updateItem = (id: string, data: any) => api.patch(`/items/${id}`, data);
export const transitionItem = (id: string, data: any) =>
  api.post(`/items/${id}/transitions`, data);

// Audit
export const getAuditTrail = (itemId: string) => api.get(`/audit/items/${itemId}`);
export const verifyIntegrity = (itemId: string) => api.get(`/audit/items/${itemId}/verify`);

// Notifications
export const getNotifications = () => api.get('/notifications');

// Search
export const searchItems = (filters: Record<string, string>) =>
  api.get('/search/items', { params: filters });
```

---

## 10. Git Commit Strategy

The assessment requires **clear commit history**. Use this structure:

```bash
git commit -m "chore: initial project setup — NestJS + Next.js + Prisma + Docker"
git commit -m "feat: database schema — workflow templates, items, audit events, notifications"
git commit -m "feat: workflow templates — CRUD with arbitrary graph transitions"
git commit -m "feat: workflow items — create, transition, assign, comment with audit events"
git commit -m "feat: enforced transitions — policy layer with data-driven permissions"
git commit -m "feat: audit trail — event sourcing with state reconstruction and integrity verification"
git commit -m "feat: concurrency safety — optimistic locking + row locks with stress tests"
git commit -m "feat: crash recovery — reconcile() with complete-forward strategy"
git commit -m "feat: document attachments — file upload with versioning"
git commit -m "feat: notification queue — persistent outbox with separate processor"
git commit -m "feat: search and pagination — filtering by state, user, type, date range"
git commit -m "test: complete test suite — all mandatory test types covered"
git commit -m "docs: architecture notes, API documentation, setup instructions"
```

---

## 11. Assessment Mapping — Full Summary

| # | Requirement | Guide(s) | Implementation |
|---|-------------|----------|----------------|
| 1 | Workflow templates | 02, 03 | Arbitrary graph, data-driven permissions |
| 2 | Workflow items | 02, 04 | CRUD, assignments, comments, attachments |
| 3 | Enforced transitions | 05 | Policy layer, server-side validation |
| 4 | Immutable audit trail | 06 | Event sourcing, state reconstruction |
| 5 | Concurrency — transitions | 07 | 25-user stress test, exactly-one-wins |
| 6 | Concurrency — field edits | 07 | Version-checked optimistic locking |
| 7 | Crash recovery | 08 | reconcile(), complete-forward |
| 8 | Notification queue | 10 | Persistent outbox, separate processor |
| 9 | Document attachments | 09 | Versioning, permission-respecting |
| 10 | Search & pagination | 11 | Multi-filter, offset pagination |
| 11 | Complete test suite | All | 12 test categories covered |

---

## 12. Assessment Submission Checklist

- [ ] GitHub repository with clear commit history
- [ ] README.md with setup instructions
- [ ] Docker Compose for one-command setup
- [ ] Database schema / ER diagram (Guide 02)
- [ ] API documentation (Swagger at `/api/docs`)
- [ ] Architecture notes explaining key decisions
- [ ] Complete automated test suite
- [ ] 10–15 minute demo video covering:
  - [ ] Solution architecture overview
  - [ ] Key design decisions (event sourcing, optimistic locking, outbox pattern)
  - [ ] Core functionality demo
  - [ ] Test results (especially concurrency stress tests)

---

**🎉 You've now completed all 11 guides. Follow them in order to build a complete WorkflowCore implementation that addresses every assessment requirement.**
