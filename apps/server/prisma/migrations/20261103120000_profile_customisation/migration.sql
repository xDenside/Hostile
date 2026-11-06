ALTER TABLE "users" ADD COLUMN     "avatarMediaId" UUID,
ADD COLUMN     "bannerColor" TEXT,
ADD COLUMN     "bannerMediaId" UUID,
ADD COLUMN     "nameColor" TEXT,
ADD COLUMN     "nameColor2" TEXT,
ADD COLUMN     "nameEffect" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "nameFont" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE "profile_media" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_media_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "profile_media_ownerId_kind_idx" ON "profile_media"("ownerId", "kind");

ALTER TABLE "users" ADD CONSTRAINT "users_avatarMediaId_fkey" FOREIGN KEY ("avatarMediaId") REFERENCES "profile_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_bannerMediaId_fkey" FOREIGN KEY ("bannerMediaId") REFERENCES "profile_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "profile_media" ADD CONSTRAINT "profile_media_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
