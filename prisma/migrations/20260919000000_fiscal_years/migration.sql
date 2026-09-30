CREATE TABLE "FiscalYear" (
  "id" TEXT PRIMARY KEY,
  "startDate" DATE,
  "endDate" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalYear_dates_check" CHECK (("id" = 'legacy' AND "startDate" IS NULL AND "endDate" IS NULL) OR ("startDate" IS NOT NULL AND "endDate" > "startDate"))
);
CREATE UNIQUE INDEX "FiscalYear_startDate_key" ON "FiscalYear"("startDate");
ALTER TABLE "FiscalYear" ADD CONSTRAINT "FiscalYear_no_overlap" EXCLUDE USING gist (daterange("startDate", "endDate", '[)') WITH &&) WHERE ("startDate" IS NOT NULL);
INSERT INTO "FiscalYear" ("id") VALUES ('legacy');
ALTER TABLE "Client" ADD COLUMN "fiscalYearId" TEXT NOT NULL DEFAULT 'legacy', ADD COLUMN "lineageId" TEXT;
UPDATE "Client" SET "lineageId" = "id";
ALTER TABLE "Client" ALTER COLUMN "lineageId" SET NOT NULL;
ALTER TABLE "Client" ADD CONSTRAINT "Client_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Client_fiscalYearId_lineageId_key" ON "Client"("fiscalYearId", "lineageId");
CREATE UNIQUE INDEX "Client_id_fiscalYearId_key" ON "Client"("id", "fiscalYearId");
ALTER TABLE "Engagement" ADD COLUMN "fiscalYearId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Engagement" DROP CONSTRAINT "Engagement_clientId_fkey";
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_clientId_fiscalYearId_fkey" FOREIGN KEY ("clientId", "fiscalYearId") REFERENCES "Client"("id", "fiscalYearId") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Engagement_fiscalYearId_idx" ON "Engagement"("fiscalYearId");
