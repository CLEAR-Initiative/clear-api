-- CreateTable
CREATE TABLE "developer_profile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "personal_website" TEXT,
    "organisation" TEXT,
    "organisation_website" TEXT,
    "linkedin_url" TEXT,
    "github_url" TEXT,
    "contribution_interest" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developer_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "developer_profile_user_id_key" ON "developer_profile"("user_id");

-- AddForeignKey
ALTER TABLE "developer_profile" ADD CONSTRAINT "developer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

