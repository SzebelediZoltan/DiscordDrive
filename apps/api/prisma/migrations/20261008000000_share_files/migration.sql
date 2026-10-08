-- CreateEnum
CREATE TYPE "ShareMode" AS ENUM ('RESTRICTED', 'LINK', 'SPECIFIC');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'FILE_SHARE_CHANGED';

-- AlterTable
ALTER TABLE "files"
  ADD COLUMN "shareMode" "ShareMode" NOT NULL DEFAULT 'RESTRICTED',
  ADD COLUMN "shareToken" TEXT;

-- CreateTable
CREATE TABLE "file_shares" (
  "id" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "file_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_shares_fileId_userId_key" ON "file_shares"("fileId", "userId");

-- CreateIndex
CREATE INDEX "file_shares_userId_idx" ON "file_shares"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "files_shareToken_key" ON "files"("shareToken");

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_shares" ADD CONSTRAINT "file_shares_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;