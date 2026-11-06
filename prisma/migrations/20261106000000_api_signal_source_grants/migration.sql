-- CreateTable
CREATE TABLE "api_signal_source_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "data_source_id" TEXT NOT NULL,
    "granted_by_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_signal_source_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_signal_source_grants_user_id_data_source_id_key" ON "api_signal_source_grants"("user_id", "data_source_id");

-- CreateIndex
CREATE INDEX "api_signal_source_grants_user_id_idx" ON "api_signal_source_grants"("user_id");

-- AddForeignKey
ALTER TABLE "api_signal_source_grants" ADD CONSTRAINT "api_signal_source_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_signal_source_grants" ADD CONSTRAINT "api_signal_source_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_signal_source_grants" ADD CONSTRAINT "api_signal_source_grants_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
