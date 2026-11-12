ALTER TABLE "sessions" ADD COLUMN "deviceKey" TEXT;

CREATE UNIQUE INDEX "sessions_deviceKey_key" ON "sessions"("deviceKey");

CREATE TABLE "room_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "joinRequestsClosed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_settings_pkey" PRIMARY KEY ("id")
);
