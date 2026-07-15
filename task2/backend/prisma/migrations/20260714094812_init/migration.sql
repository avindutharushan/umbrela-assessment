-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_stages" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_start" BOOLEAN NOT NULL DEFAULT false,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_transitions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "from_stage_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transition_permissions" (
    "id" UUID NOT NULL,
    "transition_id" UUID NOT NULL,
    "role" TEXT,
    "user_id" UUID,

    CONSTRAINT "transition_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_items" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "current_stage_id" UUID NOT NULL,
    "due_date" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_item_assignments" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_item_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "sequence_num" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_item_comments" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_item_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_attachments" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "version_num" INTEGER NOT NULL DEFAULT 1,
    "is_latest" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "template_stages_template_id_name_key" ON "template_stages"("template_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "stage_transitions_from_stage_id_to_stage_id_key" ON "stage_transitions"("from_stage_id", "to_stage_id");

-- CreateIndex
CREATE INDEX "workflow_items_template_id_idx" ON "workflow_items"("template_id");

-- CreateIndex
CREATE INDEX "workflow_items_current_stage_id_idx" ON "workflow_items"("current_stage_id");

-- CreateIndex
CREATE INDEX "workflow_items_created_at_idx" ON "workflow_items"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_item_assignments_item_id_user_id_key" ON "workflow_item_assignments"("item_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_events_item_id_sequence_num_idx" ON "audit_events"("item_id", "sequence_num");

-- CreateIndex
CREATE INDEX "audit_events_item_id_created_at_idx" ON "audit_events"("item_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events"("actor_id");

-- CreateIndex
CREATE INDEX "workflow_item_comments_item_id_created_at_idx" ON "workflow_item_comments"("item_id", "created_at");

-- CreateIndex
CREATE INDEX "document_attachments_item_id_file_name_version_num_idx" ON "document_attachments"("item_id", "file_name", "version_num");

-- CreateIndex
CREATE INDEX "document_attachments_item_id_is_latest_idx" ON "document_attachments"("item_id", "is_latest");

-- CreateIndex
CREATE INDEX "notification_outbox_status_created_at_idx" ON "notification_outbox"("status", "created_at");

-- AddForeignKey
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_stages" ADD CONSTRAINT "template_stages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "template_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "template_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transition_permissions" ADD CONSTRAINT "transition_permissions_transition_id_fkey" FOREIGN KEY ("transition_id") REFERENCES "stage_transitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_items" ADD CONSTRAINT "workflow_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_items" ADD CONSTRAINT "workflow_items_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "template_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_item_assignments" ADD CONSTRAINT "workflow_item_assignments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "workflow_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_item_assignments" ADD CONSTRAINT "workflow_item_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "workflow_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_item_comments" ADD CONSTRAINT "workflow_item_comments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "workflow_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_item_comments" ADD CONSTRAINT "workflow_item_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "workflow_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
