CREATE TYPE "Role" AS ENUM ('OWNER', 'MEMBER');

CREATE TYPE "ChannelType" AS ENUM ('TEXT', 'VOICE');

CREATE TYPE "ClientKind" AS ENUM ('WEB', 'DESKTOP');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "disabledAt" TIMESTAMPTZ(3),
    "passwordChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "client" "ClientKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "note" TEXT,
    "maxUses" INTEGER NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invite_uses" (
    "id" UUID NOT NULL,
    "inviteId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_uses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_reset_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedById" UUID,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "changeCounter" INTEGER NOT NULL DEFAULT 0,
    "lastMessageSeq" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "changeSeq" INTEGER NOT NULL,
    "clientNonce" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "read_states" (
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "lastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "read_states_pkey" PRIMARY KEY ("userId","channelId")
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

CREATE UNIQUE INDEX "invites_codeHash_key" ON "invites"("codeHash");

CREATE INDEX "invites_createdAt_idx" ON "invites"("createdAt");

CREATE UNIQUE INDEX "invite_uses_userId_key" ON "invite_uses"("userId");

CREATE INDEX "invite_uses_inviteId_idx" ON "invite_uses"("inviteId");

CREATE UNIQUE INDEX "password_reset_codes_codeHash_key" ON "password_reset_codes"("codeHash");

CREATE INDEX "password_reset_codes_userId_idx" ON "password_reset_codes"("userId");

CREATE INDEX "channels_archivedAt_position_idx" ON "channels"("archivedAt", "position");

CREATE UNIQUE INDEX "messages_channelId_seq_key" ON "messages"("channelId", "seq");

CREATE UNIQUE INDEX "messages_channelId_changeSeq_key" ON "messages"("channelId", "changeSeq");

CREATE UNIQUE INDEX "messages_authorId_clientNonce_key" ON "messages"("authorId", "clientNonce");

CREATE INDEX "read_states_channelId_idx" ON "read_states"("channelId");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invites" ADD CONSTRAINT "invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invite_uses" ADD CONSTRAINT "invite_uses_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invite_uses" ADD CONSTRAINT "invite_uses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_reset_codes" ADD CONSTRAINT "password_reset_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_reset_codes" ADD CONSTRAINT "password_reset_codes_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "messages" ADD CONSTRAINT "messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages" ADD CONSTRAINT "messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "read_states" ADD CONSTRAINT "read_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "read_states" ADD CONSTRAINT "read_states_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invites" ADD CONSTRAINT "invites_uses_within_limit" CHECK ("uses" >= 0 AND "uses" <= "maxUses" AND "maxUses" >= 1);
ALTER TABLE "channels" ADD CONSTRAINT "channels_counters_nonnegative" CHECK ("changeCounter" >= 0 AND "lastMessageSeq" >= 0 AND "lastMessageSeq" <= "changeCounter");
ALTER TABLE "messages" ADD CONSTRAINT "messages_seq_order" CHECK ("seq" > 0 AND "changeSeq" >= "seq");
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_seq_nonnegative" CHECK ("lastReadSeq" >= 0);
