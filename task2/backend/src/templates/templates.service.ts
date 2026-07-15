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

      // Return the full template with all relations from within the transaction
      return tx.workflowTemplate.findUnique({
        where: { id: template.id },
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
   */
  async update(id: string, dto: UpdateTemplateDto, userId: string) {
    const template = await this.findOne(id);

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
