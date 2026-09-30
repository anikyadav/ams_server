CREATE TYPE "public"."TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
ALTER TABLE "public"."SubTask" ADD COLUMN "dueDate" DATE, ADD COLUMN "priority" "public"."TaskPriority" NOT NULL DEFAULT 'MEDIUM';
