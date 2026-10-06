-- AlterEnum
-- PostgreSQL 17 can add a value to an enum without rewriting the table,
-- as long as no constraint re-validation is involved.
ALTER TYPE "AuditAction" ADD VALUE 'FILE_VERIFIED';