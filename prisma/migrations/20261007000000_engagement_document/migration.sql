ALTER TABLE "SubTask" ADD COLUMN "templateKey" TEXT,
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 100;

CREATE TABLE "ClientIrdCredential" (
  "clientId" TEXT NOT NULL,
  "registrationNo" VARCHAR(200),
  "userId" VARCHAR(200),
  "passwordEncrypted" TEXT,
  "nextRenewalDate" DATE,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientIrdCredential_pkey" PRIMARY KEY ("clientId"),
  CONSTRAINT "ClientIrdCredential_clientId_fkey" FOREIGN KEY ("clientId")
    REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "IrdCredentialAccessLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "fiscalYearId" TEXT NOT NULL,
  "clientId" TEXT,
  "action" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IrdCredentialAccessLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IrdCredentialAccessLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "IrdCredentialAccessLog_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "IrdCredentialAccessLog_fiscalYearId_createdAt_idx" ON "IrdCredentialAccessLog"("fiscalYearId", "createdAt");
