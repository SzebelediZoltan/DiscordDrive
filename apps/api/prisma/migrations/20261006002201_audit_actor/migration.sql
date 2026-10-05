-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actorUserId" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

