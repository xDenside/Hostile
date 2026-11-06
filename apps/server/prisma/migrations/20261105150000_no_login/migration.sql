ALTER TABLE "invites" DROP CONSTRAINT "invites_createdById_fkey";
ALTER TABLE "invite_uses" DROP CONSTRAINT "invite_uses_inviteId_fkey";
ALTER TABLE "invite_uses" DROP CONSTRAINT "invite_uses_userId_fkey";
ALTER TABLE "password_reset_codes" DROP CONSTRAINT "password_reset_codes_userId_fkey";
ALTER TABLE "password_reset_codes" DROP CONSTRAINT "password_reset_codes_issuedById_fkey";

DROP TABLE "invite_uses";
DROP TABLE "invites";
DROP TABLE "password_reset_codes";

DROP INDEX "users_username_key";

ALTER TABLE "users" DROP COLUMN "username",
DROP COLUMN "passwordHash",
DROP COLUMN "passwordChangedAt";

ALTER TABLE "sessions" DROP COLUMN "expiresAt";
