-- Task sign-off (preparer submits, auditor approves), blocked flag, task checklist
-- steps and engagement document requests.
CREATE TYPE "ReviewState" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED');
CREATE TYPE "DocumentRequestStatus" AS ENUM ('REQUESTED', 'RECEIVED');

ALTER TABLE "SubTask"
  ADD COLUMN "reviewState" "ReviewState" NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "submittedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "blockedReason" TEXT,
  ADD COLUMN "blockedAt" TIMESTAMP(3);

ALTER TABLE "SubTask"
  ADD CONSTRAINT "SubTask_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "SubTask_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Work finished before sign-off existed counts as approved, so nothing already
-- completed becomes blocked by the new completion rule.
UPDATE "SubTask"
SET "reviewState" = 'APPROVED', "reviewedAt" = COALESCE("completedAt", "createdAt")
WHERE "status" = 'DONE';

CREATE TABLE "TaskChecklistItem" (
  "id" TEXT NOT NULL,
  "subTaskId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "doneAt" TIMESTAMP(3),
  "doneById" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskChecklistItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskChecklistItem_subTaskId_fkey" FOREIGN KEY ("subTaskId") REFERENCES "SubTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskChecklistItem_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "TaskChecklistItem_subTaskId_idx" ON "TaskChecklistItem"("subTaskId");

CREATE TABLE "DocumentRequest" (
  "id" TEXT NOT NULL,
  "engagementId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "dueDate" DATE,
  "status" "DocumentRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "reference" TEXT,
  "receivedAt" TIMESTAMP(3),
  "receivedById" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentRequest_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentRequest_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DocumentRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DocumentRequest_engagementId_idx" ON "DocumentRequest"("engagementId");
