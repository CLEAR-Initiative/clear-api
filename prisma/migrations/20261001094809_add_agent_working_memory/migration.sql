-- CreateTable
CREATE TABLE "agent_working_memory" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "working_memory" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_working_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_working_memory_user_id_key" ON "agent_working_memory"("user_id");

-- AddForeignKey
ALTER TABLE "agent_working_memory" ADD CONSTRAINT "agent_working_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
