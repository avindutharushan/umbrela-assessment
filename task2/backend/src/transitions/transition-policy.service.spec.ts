import { Test, TestingModule } from '@nestjs/testing';
import { TransitionPolicyService } from './transition-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('TransitionPolicyService', () => {
  let service: TransitionPolicyService;

  const mockPrisma = {
    stageTransition: { findUnique: jest.fn(), findMany: jest.fn() },
    workflowItem: { findUnique: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransitionPolicyService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TransitionPolicyService>(TransitionPolicyService);
    jest.clearAllMocks();
  });

  describe('validateTransition', () => {
    it('should reject an invalid transition (no edge in graph)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue(null);

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-c', // no direct edge
          actorId: 'user-1',
          actorRole: 'USER',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when user lacks permission (role-based)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [{ role: 'ADMIN', userId: null }], // Only ADMIN allowed
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'user-1',
          actorRole: 'USER', // Not ADMIN!
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow when user has role-based permission', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [{ role: 'USER', userId: null }],
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'user-1',
          actorRole: 'USER',
        }),
      ).resolves.toBeUndefined();
    });

    it('should allow when user has user-specific permission', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [{ role: null, userId: 'specific-user-id' }],
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'specific-user-id',
          actorRole: 'USER',
        }),
      ).resolves.toBeUndefined();
    });

    it('should allow open transitions (no permissions defined)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [], // No permissions = open to all
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-a',
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a',
          toStageId: 'stage-b',
          actorId: 'any-user',
          actorRole: 'USER',
        }),
      ).resolves.toBeUndefined();
    });

    it('should reject when item is in a different stage (stale state)', async () => {
      mockPrisma.stageTransition.findUnique.mockResolvedValue({
        id: 't-1',
        fromStage: { id: 'stage-a', name: 'Draft', templateId: 'tmpl-1' },
        toStage: { id: 'stage-b', name: 'Review' },
        permissions: [],
      });
      mockPrisma.workflowItem.findUnique.mockResolvedValue({
        currentStageId: 'stage-c', // Item already moved to stage-c!
        templateId: 'tmpl-1',
      });

      await expect(
        service.validateTransition({
          itemId: 'item-1',
          fromStageId: 'stage-a', // Client thinks it's still in stage-a
          toStageId: 'stage-b',
          actorId: 'user-1',
          actorRole: 'USER',
        }),
      ).rejects.toThrow('no longer in the expected stage');
    });
  });
});
