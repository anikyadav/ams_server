ALTER TABLE "Engagement" ADD COLUMN "manualProgress" INTEGER;
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_manualProgress_check" CHECK ("manualProgress" IN (0, 25, 50, 75, 100));
