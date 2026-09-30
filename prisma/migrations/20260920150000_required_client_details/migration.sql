ALTER TABLE "public"."Client"
ALTER COLUMN "pan" SET NOT NULL,
ALTER COLUMN "fileLocation" SET NOT NULL;

ALTER TABLE "public"."Client"
ADD CONSTRAINT "Client_name_required" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
ADD CONSTRAINT "Client_fileLocation_required" CHECK (char_length(btrim("fileLocation")) BETWEEN 1 AND 1000);
