-- Preserve any work already recorded under the obsolete default "Any other".
DELETE FROM "SubTask" t
WHERE t."templateKey" = 'OTHER' AND t."status" = 'TODO' AND t."progress" = 0
  AND t."description" IS NULL AND t."dueDate" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Comment" c WHERE c."subTaskId" = t."id")
  AND NOT EXISTS (SELECT 1 FROM "ActivityLog" a WHERE a."subTaskId" = t."id");
UPDATE "SubTask" SET "templateKey" = NULL, "sortOrder" = 100 WHERE "templateKey" = 'OTHER';

-- Keep duplicate records as additional tasks instead of discarding their history.
WITH duplicates AS (
  SELECT "id", row_number() OVER (PARTITION BY "engagementId", "templateKey" ORDER BY "createdAt", "id") AS position
  FROM "SubTask" WHERE "templateKey" IS NOT NULL
)
UPDATE "SubTask" t SET "templateKey" = NULL, "sortOrder" = 100
FROM duplicates d WHERE t."id" = d."id" AND d.position > 1;

-- Adopt the earliest existing task with an exact matching normalized name.
WITH required("templateKey", title, "sortOrder", normalized) AS (
  VALUES ('DOCUMENT','Document',1,'document'), ('VAT_RECO','Vat Reco',2,'vatreco'),
    ('SALES_RECO','Sales Reco',3,'salesreco'), ('PURCHASE_RECO','Purchase Reco',4,'purchasereco'),
    ('SALES_CONFIRMATION','Sales Confirmation',5,'salesconfirmation'), ('PURCHASE_CONFIRMATION','Purchase Confirmation',6,'purchaseconfirmation')
), candidates AS (
  SELECT t."id", r."templateKey", r."sortOrder",
    row_number() OVER (PARTITION BY t."engagementId", r."templateKey" ORDER BY t."createdAt", t."id") AS position
  FROM "SubTask" t JOIN required r ON lower(regexp_replace(t."title", '[^a-zA-Z]', '', 'g')) = r.normalized
  WHERE t."templateKey" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "SubTask" existing WHERE existing."engagementId" = t."engagementId" AND existing."templateKey" = r."templateKey"
  )
)
UPDATE "SubTask" t SET "templateKey" = c."templateKey", "sortOrder" = c."sortOrder"
FROM candidates c WHERE t."id" = c."id" AND c.position = 1;

-- Add only missing compulsory tasks to every existing engagement.
WITH required("templateKey", title, "sortOrder") AS (
  VALUES ('DOCUMENT','Document',1), ('VAT_RECO','Vat Reco',2), ('SALES_RECO','Sales Reco',3),
    ('PURCHASE_RECO','Purchase Reco',4), ('SALES_CONFIRMATION','Sales Confirmation',5), ('PURCHASE_CONFIRMATION','Purchase Confirmation',6)
)
INSERT INTO "SubTask" ("id", "engagementId", "title", "templateKey", "sortOrder", "assignedToId")
SELECT 'required_' || md5(e."id" || ':' || r."templateKey"), e."id", r.title, r."templateKey", r."sortOrder", e."staffId"
FROM "Engagement" e CROSS JOIN required r
WHERE NOT EXISTS (SELECT 1 FROM "SubTask" t WHERE t."engagementId" = e."id" AND t."templateKey" = r."templateKey");

CREATE UNIQUE INDEX "SubTask_engagementId_templateKey_key" ON "SubTask"("engagementId", "templateKey");
