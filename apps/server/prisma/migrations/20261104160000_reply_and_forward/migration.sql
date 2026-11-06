ALTER TABLE "messages" ADD COLUMN     "forwardedFromAuthorId" UUID,
ADD COLUMN     "forwardedFromChannelId" UUID,
ADD COLUMN     "forwardedFromChannelName" TEXT,
ADD COLUMN     "forwardedFromCreatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "forwardedFromMessageId" UUID,
ADD COLUMN     "replyToId" UUID;

CREATE INDEX "messages_replyToId_idx" ON "messages"("replyToId");

CREATE INDEX "messages_forwardedFromMessageId_idx" ON "messages"("forwardedFromMessageId");

ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "messages" ADD CONSTRAINT "messages_forwardedFromMessageId_fkey" FOREIGN KEY ("forwardedFromMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
