ALTER TABLE "Client"
ADD COLUMN "pan" VARCHAR(9),
ADD COLUMN "fileLocation" TEXT;

ALTER TABLE "Client"
ADD CONSTRAINT "Client_pan_check" CHECK ("pan" IS NULL OR "pan" ~ '^[0-9]{9}$');
