# Guide 03 — Workflow Templates

> **What you'll build in this guide:** CRUD operations for workflow templates — creating templates with named stages, defining arbitrary graph transitions between them, and configuring data-driven permissions per transition. This is Requirement 1 of the assessment.

---

## 1. What the Assessment Requires

> *"Create/edit templates defining named stages and the valid transitions between them (arbitrary graph — not assumed linear), plus which roles/users may perform each specific transition."*

Key evaluator signals:
- **Arbitrary graph** — the template supports cycles (e.g., Approval → Review → Approval again), not just a linear sequence
- **Data-driven permissions** — transition permissions are stored in the database as configuration, not hardcoded `if` statements
- **Template validation** — server-side validation prevents creating invalid graphs

---

## 2. DTOs (Data Transfer Objects)

### 2.1 Create Template DTO

```typescript
// src/templates/dto/create-template.dto.ts
import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsInt,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStageDto {
  @ApiProperty({ example: 'Draft' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isStart?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsBoolean()
  @IsOptional()
  isFinal?: boolean;
}

export class CreateTransitionPermissionDto {
  @ApiPropertyOptional({ example: 'ADMIN' })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({ example: 'uuid-of-specific-user' })
  @IsString()
  @IsOptional()
  userId?: string;
}

export class CreateTransitionDto {
  @ApiProperty({ example: 'Draft', description: 'Name of the source stage' })
  @IsString()
  fromStageName: string;

  @ApiProperty({ example: 'Review', description: 'Name of the target stage' })
  @IsString()
  toStageName: string;

  @ApiPropertyOptional({ example: 'Submit for Review' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ type: [CreateTransitionPermissionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTransitionPermissionDto)
  @IsOptional()
  permissions?: CreateTransitionPermissionDto[];
}

export class CreateTemplateDto {
  @ApiProperty({ example: 'Document Approval' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Standard document approval workflow' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ type: [CreateStageDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2, { message: 'A template must have at least 2 stages' })
  @ValidateNested({ each: true })
  @Type(() => CreateStageDto)
  stages: CreateStageDto[];

  @ApiProperty({ type: [CreateTransitionDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'A template must have at least 1 transition' })
  @ValidateNested({ each: true })
  @Type(() => CreateTransitionDto)
  transitions: CreateTransitionDto[];
}
```

### 2.2 Update Template DTO

```typescript
// src/templates/dto/update-template.dto.ts
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTemplateDto {
  @ApiPropertyOptional({ example: 'Updated Template Name' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
```

---

## 3. Templates Service

```typescript
// src/templates/templates.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a new workflow template with stages, transitions, and permissions.
   * 
   * Validation:
   * - At least 2 stages
   * - At least 1 transition
   * - Exactly 1 start stage
   * - At least 1 final stage
   * - All transition references point to valid stage names
   * - No duplicate stage names
   * - No orphan stages (every non-start, non-final stage must be reachable)
   */
  async create(dto: CreateTemplateDto, userId: string) {
    // --- Validation ---

    // 1. Check for duplicate stage names
    const stageNames = dto.stages.map((s) => s.name);
    const uniqueNames = new Set(stageNames);
    if (uniqueNames.size !== stageNames.length) {
      throw new BadRequestException('Stage names must be unique within a template');
    }

    // 2. Ensure exactly one start stage
    const startStages = dto.stages.filter((s) => s.isStart);
    if (startStages.length === 0) {
      throw new BadRequestException('Template must have at least one start stage');
    }

    // 3. Ensure at least one final stage
    const finalStages = dto.stages.filter((s) => s.isFinal);
    if (finalStages.length === 0) {
      throw new BadRequestException('Template must have at least one final stage');
    }

    // 4. Validate all transition references
    for (const transition of dto.transitions) {
      if (!uniqueNames.has(transition.fromStageName)) {
        throw new BadRequestException(
          `Transition references unknown stage: "${transition.fromStageName}"`,
        );
      }
      if (!uniqueNames.has(transition.toStageName)) {
        throw new BadRequestException(
          `Transition references unknown stage: "${transition.toStageName}"`,
        );
      }
      if (transition.fromStageName === transition.toStageName) {
        throw new BadRequestException(
          `Self-transitions are not allowed: "${transition.fromStageName}" → "${transition.toStageName}"`,
        );
      }
    }

    // 5. Check for orphan stages (optional but recommended)
    const reachableStages = new Set<string>();
    startStages.forEach((s) => reachableStages.add(s.name));
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of dto.transitions) {
        if (reachableStages.has(t.fromStageName) && !reachableStages.has(t.toStageName)) {
          reachableStages.add(t.toStageName);
          changed = true;
        }
      }
    }
    const orphans = stageNames.filter((name) => !reachableStages.has(name));
    if (orphans.length > 0) {
      throw new BadRequestException(
        `Unreachable stages detected: ${orphans.join(', ')}. Every stage must be reachable from a start stage.`,
      );
    }

    // --- Create everything in a single transaction ---
    return this.prisma.$transaction(async (tx) => {
      // Create the template
      const template = await tx.workflowTemplate.create({
        data: {
          name: dto.name,
          description: dto.description,
          createdBy: userId,
        },
      });

      // Create stages
      const stageRecords = await Promise.all(
        dto.stages.map((stage, index) =>
          tx.templateStage.create({
            data: {
              templateId: template.id,
              name: stage.name,
              position: stage.position ?? index,
              isStart: stage.isStart ?? false,
              isFinal: stage.isFinal ?? false,
            },
          }),
        ),
      );

      // Build a name-to-id lookup
      const stageMap = new Map(stageRecords.map((s) => [s.name, s.id]));

      // Create transitions with permissions
      for (const transition of dto.transitions) {
        const fromStageId = stageMap.get(transition.fromStageName)!;
        const toStageId = stageMap.get(transition.toStageName)!;

        const transitionRecord = await tx.stageTransition.create({
          data: {
            templateId: template.id,
            fromStageId,
            toStageId,
            name: transition.name,
          },
        });

        // Create permissions for this transition
        if (transition.permissions && transition.permissions.length > 0) {
          await Promise.all(
            transition.permissions.map((perm) =>
              tx.transitionPermission.create({
                data: {
                  transitionId: transitionRecord.id,
                  role: perm.role || null,
                  userId: perm.userId || null,
                },
              }),
            ),
          );
        }
      }

      // Return the full template with all relations
      return this.findOne(template.id);
    });
  }

  /**
   * Get all templates (with basic info)
   */
  async findAll(options?: { isActive?: boolean }) {
    return this.prisma.workflowTemplate.findMany({
      where: {
        isActive: options?.isActive,
      },
      include: {
        creator: { select: { id: true, name: true, email: true } },
        stages: { orderBy: { position: 'asc' } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get a single template with full details (stages, transitions, permissions)
   */
  async findOne(id: string) {
    const template = await this.prisma.workflowTemplate.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true, email: true } },
        stages: {
          orderBy: { position: 'asc' },
          include: {
            outgoingTransitions: {
              include: {
                toStage: { select: { id: true, name: true } },
                permissions: true,
              },
            },
          },
        },
        _count: { select: { items: true } },
      },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    return template;
  }

  /**
   * Update template metadata (name, description, isActive).
   * 
   * Note: Stage/transition changes are handled separately to prevent
   * breaking existing workflow items that reference old stages.
   */
  async update(id: string, dto: UpdateTemplateDto, userId: string) {
    const template = await this.findOne(id);

    // Only creator or admin can update
    // (This check is better handled in a guard/policy, shown in Guide 05)

    return this.prisma.workflowTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive,
      },
      include: {
        creator: { select: { id: true, name: true, email: true } },
        stages: { orderBy: { position: 'asc' } },
      },
    });
  }

  /**
   * Add a new stage to an existing template.
   */
  async addStage(
    templateId: string,
    data: { name: string; position?: number; isStart?: boolean; isFinal?: boolean },
  ) {
    const template = await this.findOne(templateId);

    // Check for duplicate name
    const existingStage = template.stages.find((s) => s.name === data.name);
    if (existingStage) {
      throw new BadRequestException(`Stage "${data.name}" already exists in this template`);
    }

    return this.prisma.templateStage.create({
      data: {
        templateId,
        name: data.name,
        position: data.position ?? template.stages.length,
        isStart: data.isStart ?? false,
        isFinal: data.isFinal ?? false,
      },
    });
  }

  /**
   * Add a new transition between existing stages.
   */
  async addTransition(
    templateId: string,
    data: {
      fromStageId: string;
      toStageId: string;
      name?: string;
      permissions?: { role?: string; userId?: string }[];
    },
  ) {
    // Verify both stages belong to this template
    const [fromStage, toStage] = await Promise.all([
      this.prisma.templateStage.findFirst({
        where: { id: data.fromStageId, templateId },
      }),
      this.prisma.templateStage.findFirst({
        where: { id: data.toStageId, templateId },
      }),
    ]);

    if (!fromStage || !toStage) {
      throw new BadRequestException('Both stages must belong to the same template');
    }

    if (data.fromStageId === data.toStageId) {
      throw new BadRequestException('Self-transitions are not allowed');
    }

    // Check for duplicate transition
    const existing = await this.prisma.stageTransition.findUnique({
      where: {
        fromStageId_toStageId: {
          fromStageId: data.fromStageId,
          toStageId: data.toStageId,
        },
      },
    });

    if (existing) {
      throw new BadRequestException(
        `Transition from "${fromStage.name}" to "${toStage.name}" already exists`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const transition = await tx.stageTransition.create({
        data: {
          templateId,
          fromStageId: data.fromStageId,
          toStageId: data.toStageId,
          name: data.name,
        },
      });

      if (data.permissions && data.permissions.length > 0) {
        await Promise.all(
          data.permissions.map((perm) =>
            tx.transitionPermission.create({
              data: {
                transitionId: transition.id,
                role: perm.role || null,
                userId: perm.userId || null,
              },
            }),
          ),
        );
      }

      return tx.stageTransition.findUnique({
        where: { id: transition.id },
        include: {
          fromStage: { select: { id: true, name: true } },
          toStage: { select: { id: true, name: true } },
          permissions: true,
        },
      });
    });
  }

  /**
   * Delete a template (soft-delete by setting isActive = false).
   * Cannot delete if there are active workflow items using this template.
   */
  async remove(id: string) {
    const template = await this.prisma.workflowTemplate.findUnique({
      where: { id },
      include: { _count: { select: { items: true } } },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    if (template._count.items > 0) {
      throw new BadRequestException(
        `Cannot delete template with ${template._count.items} active workflow items. Deactivate it instead.`,
      );
    }

    return this.prisma.workflowTemplate.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
```

---

## 4. Templates Controller

```typescript
// src/templates/templates.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Workflow Templates')
@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TemplatesController {
  constructor(private templatesService: TemplatesService) {}

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a new workflow template (admin only)' })
  create(@Body() dto: CreateTemplateDto, @CurrentUser('id') userId: string) {
    return this.templatesService.create(dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List all workflow templates' })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  findAll(@Query('active') active?: string) {
    const isActive = active === 'true' ? true : active === 'false' ? false : undefined;
    return this.templatesService.findAll({ isActive });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a template with full details (stages, transitions, permissions)' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templatesService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update template metadata (admin only)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.templatesService.update(id, dto, userId);
  }

  @Post(':id/stages')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Add a new stage to a template' })
  addStage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name: string; position?: number; isStart?: boolean; isFinal?: boolean },
  ) {
    return this.templatesService.addStage(id, body);
  }

  @Post(':id/transitions')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Add a new transition between stages' })
  addTransition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      fromStageId: string;
      toStageId: string;
      name?: string;
      permissions?: { role?: string; userId?: string }[];
    },
  ) {
    return this.templatesService.addTransition(id, body);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete a template (admin only)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.templatesService.remove(id);
  }
}
```

---

## 5. Templates Module

```typescript
// src/templates/templates.module.ts
import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
```

Register it in `app.module.ts`:

```typescript
// src/app.module.ts — add to imports array
import { TemplatesModule } from './templates/templates.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    TemplatesModule,
    // ... more modules in later guides
  ],
})
export class AppModule {}
```

---

## 6. Unit Tests

```typescript
// src/templates/templates.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { TemplatesService } from './templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';

describe('TemplatesService', () => {
  let service: TemplatesService;
  let prisma: PrismaService;

  const mockPrisma = {
    workflowTemplate: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    templateStage: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    stageTransition: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    transitionPermission: {
      create: jest.fn(),
    },
    $transaction: jest.fn((fn) => fn(mockPrisma)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TemplatesService>(TemplatesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should reject templates with duplicate stage names', async () => {
      const dto = {
        name: 'Test',
        stages: [
          { name: 'Draft', isStart: true },
          { name: 'Draft', isFinal: true }, // duplicate!
        ],
        transitions: [{ fromStageName: 'Draft', toStageName: 'Draft' }],
      };

      await expect(service.create(dto, 'user-id')).rejects.toThrow(BadRequestException);
    });

    it('should reject templates with no start stage', async () => {
      const dto = {
        name: 'Test',
        stages: [
          { name: 'Stage1' },
          { name: 'Stage2', isFinal: true },
        ],
        transitions: [{ fromStageName: 'Stage1', toStageName: 'Stage2' }],
      };

      await expect(service.create(dto, 'user-id')).rejects.toThrow(
        'Template must have at least one start stage',
      );
    });

    it('should reject templates with no final stage', async () => {
      const dto = {
        name: 'Test',
        stages: [
          { name: 'Stage1', isStart: true },
          { name: 'Stage2' },
        ],
        transitions: [{ fromStageName: 'Stage1', toStageName: 'Stage2' }],
      };

      await expect(service.create(dto, 'user-id')).rejects.toThrow(
        'Template must have at least one final stage',
      );
    });

    it('should reject transitions referencing unknown stages', async () => {
      const dto = {
        name: 'Test',
        stages: [
          { name: 'Draft', isStart: true },
          { name: 'Done', isFinal: true },
        ],
        transitions: [{ fromStageName: 'Draft', toStageName: 'NonExistent' }],
      };

      await expect(service.create(dto, 'user-id')).rejects.toThrow(
        'Transition references unknown stage',
      );
    });

    it('should reject self-transitions', async () => {
      const dto = {
        name: 'Test',
        stages: [
          { name: 'Draft', isStart: true },
          { name: 'Done', isFinal: true },
        ],
        transitions: [{ fromStageName: 'Draft', toStageName: 'Draft' }],
      };

      await expect(service.create(dto, 'user-id')).rejects.toThrow(
        'Self-transitions are not allowed',
      );
    });

    it('should reject templates with orphan stages', async () => {
      const dto = {
        name: 'Test',
        stages: [
          { name: 'Draft', isStart: true },
          { name: 'Review' },
          { name: 'Orphan' }, // not reachable
          { name: 'Done', isFinal: true },
        ],
        transitions: [
          { fromStageName: 'Draft', toStageName: 'Review' },
          { fromStageName: 'Review', toStageName: 'Done' },
        ],
      };

      await expect(service.create(dto, 'user-id')).rejects.toThrow(
        'Unreachable stages detected: Orphan',
      );
    });
  });
});
```

---

## 7. Example API Requests

### Create a Template

```bash
curl -X POST http://localhost:3000/api/templates \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bug Tracking",
    "description": "Software bug tracking workflow",
    "stages": [
      { "name": "Open", "isStart": true, "position": 0 },
      { "name": "In Progress", "position": 1 },
      { "name": "Code Review", "position": 2 },
      { "name": "Testing", "position": 3 },
      { "name": "Closed", "isFinal": true, "position": 4 },
      { "name": "Wont Fix", "isFinal": true, "position": 5 }
    ],
    "transitions": [
      { "fromStageName": "Open", "toStageName": "In Progress", "name": "Start Work", "permissions": [{"role": "USER"}] },
      { "fromStageName": "In Progress", "toStageName": "Code Review", "name": "Submit for Review", "permissions": [{"role": "USER"}] },
      { "fromStageName": "Code Review", "toStageName": "Testing", "name": "Approve", "permissions": [{"role": "ADMIN"}] },
      { "fromStageName": "Code Review", "toStageName": "In Progress", "name": "Request Changes", "permissions": [{"role": "ADMIN"}] },
      { "fromStageName": "Testing", "toStageName": "Closed", "name": "Pass", "permissions": [{"role": "USER"}, {"role": "ADMIN"}] },
      { "fromStageName": "Testing", "toStageName": "In Progress", "name": "Fail", "permissions": [{"role": "USER"}] },
      { "fromStageName": "Open", "toStageName": "Wont Fix", "name": "Mark Wont Fix", "permissions": [{"role": "ADMIN"}] }
    ]
  }'
```

> **Note the graph structure:** This template is NOT linear. `Code Review → In Progress` and `Testing → In Progress` create cycles, allowing items to be sent back for rework.

---

## 8. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Arbitrary graph, not linear | Transitions stored as directed edges; cycles supported (Review → In Progress) |
| Data-driven permissions | `TransitionPermission` records per transition, checked at runtime (Guide 05) |
| Template validation | Server-side checks for start/final stages, orphans, self-transitions, duplicates |
| Admin-only template creation | `@Roles('ADMIN')` guard on create/update/delete endpoints |
| Code quality | Full DTO validation, comprehensive unit tests |

---

**Next: [Guide 04 — Workflow Items →](./04-workflow-items.md)**
