CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "messageId" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "contentType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_attachments_messageId_position_key" ON "message_attachments"("messageId", "position");

ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
