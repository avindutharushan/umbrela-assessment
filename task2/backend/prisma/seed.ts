import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Create users
  const adminHash = await bcrypt.hash('admin123', 12);
  const userHash = await bcrypt.hash('user123', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@workflowcore.dev' },
    update: {},
    create: {
      email: 'admin@workflowcore.dev',
      name: 'Admin User',
      passwordHash: adminHash,
      role: 'ADMIN',
    },
  });

  const alice = await prisma.user.upsert({
    where: { email: 'alice@workflowcore.dev' },
    update: {},
    create: {
      email: 'alice@workflowcore.dev',
      name: 'Alice (Reviewer)',
      passwordHash: userHash,
      role: 'USER',
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: 'bob@workflowcore.dev' },
    update: {},
    create: {
      email: 'bob@workflowcore.dev',
      name: 'Bob (Submitter)',
      passwordHash: userHash,
      role: 'USER',
    },
  });

  // Create a sample workflow template: "Document Approval"
  const template = await prisma.workflowTemplate.create({
    data: {
      name: 'Document Approval',
      description:
        'A standard document approval workflow: Draft → Review → Approval → Completed',
      createdBy: admin.id,
      stages: {
        create: [
          { name: 'Draft', position: 0, isStart: true, isFinal: false },
          { name: 'Review', position: 1, isStart: false, isFinal: false },
          { name: 'Approval', position: 2, isStart: false, isFinal: false },
          { name: 'Completed', position: 3, isStart: false, isFinal: true },
          { name: 'Rejected', position: 4, isStart: false, isFinal: true },
        ],
      },
    },
    include: { stages: true },
  });

  const stages = template.stages.reduce(
    (acc, s) => ({ ...acc, [s.name]: s }),
    {} as Record<string, (typeof template.stages)[0]>,
  );

  // Create transitions (arbitrary graph — not linear!)
  // Draft → Review
  // Review → Approval
  // Review → Rejected   (reviewer can reject)
  // Approval → Completed
  // Approval → Review    (send back for revisions — non-linear)
  // Approval → Rejected

  const transitions = await Promise.all([
    prisma.stageTransition.create({
      data: {
        templateId: template.id,
        fromStageId: stages['Draft'].id,
        toStageId: stages['Review'].id,
        name: 'Submit for Review',
      },
    }),
    prisma.stageTransition.create({
      data: {
        templateId: template.id,
        fromStageId: stages['Review'].id,
        toStageId: stages['Approval'].id,
        name: 'Approve for Final Review',
      },
    }),
    prisma.stageTransition.create({
      data: {
        templateId: template.id,
        fromStageId: stages['Review'].id,
        toStageId: stages['Rejected'].id,
        name: 'Reject',
      },
    }),
    prisma.stageTransition.create({
      data: {
        templateId: template.id,
        fromStageId: stages['Approval'].id,
        toStageId: stages['Completed'].id,
        name: 'Final Approve',
      },
    }),
    prisma.stageTransition.create({
      data: {
        templateId: template.id,
        fromStageId: stages['Approval'].id,
        toStageId: stages['Review'].id,
        name: 'Send Back for Revisions',
      },
    }),
    prisma.stageTransition.create({
      data: {
        templateId: template.id,
        fromStageId: stages['Approval'].id,
        toStageId: stages['Rejected'].id,
        name: 'Reject',
      },
    }),
  ]);

  // Add permissions — data-driven, not hardcoded
  // "Submit for Review" — any USER can do this
  await prisma.transitionPermission.create({
    data: { transitionId: transitions[0].id, role: 'USER' },
  });

  // "Approve for Final Review" — only ADMIN
  await prisma.transitionPermission.create({
    data: { transitionId: transitions[1].id, role: 'ADMIN' },
  });

  // "Reject" from Review — only ADMIN
  await prisma.transitionPermission.create({
    data: { transitionId: transitions[2].id, role: 'ADMIN' },
  });

  // "Final Approve" — only ADMIN
  await prisma.transitionPermission.create({
    data: { transitionId: transitions[3].id, role: 'ADMIN' },
  });

  // "Send Back for Revisions" — only ADMIN
  await prisma.transitionPermission.create({
    data: { transitionId: transitions[4].id, role: 'ADMIN' },
  });

  // "Reject" from Approval — only ADMIN
  await prisma.transitionPermission.create({
    data: { transitionId: transitions[5].id, role: 'ADMIN' },
  });

  console.log('✅ Seed data created successfully');
  console.log(`   Admin: admin@workflowcore.dev / admin123`);
  console.log(`   Alice: alice@workflowcore.dev / user123`);
  console.log(`   Bob:   bob@workflowcore.dev / user123`);
  console.log(
    `   Template: "${template.name}" with ${template.stages.length} stages and ${transitions.length} transitions`,
  );
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
