CREATE TABLE "honcho_runtime_state" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_configuration',
    "configurationHash" TEXT,
    "secretId" TEXT,
    "error" TEXT,
    "components" JSONB NOT NULL DEFAULT '{}',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "embeddingSecretId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "honcho_runtime_state_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "honcho_runtime_state_secretId_key" ON "honcho_runtime_state"("secretId");
CREATE UNIQUE INDEX "honcho_runtime_state_embeddingSecretId_key" ON "honcho_runtime_state"("embeddingSecretId");
ALTER TABLE "honcho_runtime_state" ADD CONSTRAINT "honcho_runtime_state_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "honcho_runtime_state" ADD CONSTRAINT "honcho_runtime_state_embeddingSecretId_fkey" FOREIGN KEY ("embeddingSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
