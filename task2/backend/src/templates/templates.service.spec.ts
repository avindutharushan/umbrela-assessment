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

      await expect(service.create(dto as any, 'user-id')).rejects.toThrow(BadRequestException);
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

      await expect(service.create(dto as any, 'user-id')).rejects.toThrow(
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

      await expect(service.create(dto as any, 'user-id')).rejects.toThrow(
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

      await expect(service.create(dto as any, 'user-id')).rejects.toThrow(
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

      await expect(service.create(dto as any, 'user-id')).rejects.toThrow(
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

      await expect(service.create(dto as any, 'user-id')).rejects.toThrow(
        'Unreachable stages detected: Orphan',
      );
    });
  });
});
