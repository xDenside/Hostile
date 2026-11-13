CREATE TABLE "upload_hours" (
    "userId" UUID NOT NULL,
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "bytes" INTEGER NOT NULL,

    CONSTRAINT "upload_hours_pkey" PRIMARY KEY ("userId","hour")
);
