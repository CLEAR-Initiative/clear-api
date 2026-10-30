-- CreateTable
CREATE TABLE "recipient_lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipient_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipient_list_members" (
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "unsubscribe_token" TEXT NOT NULL,
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipient_list_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipient_lists_name_key" ON "recipient_lists"("name");

-- CreateIndex
CREATE UNIQUE INDEX "recipient_list_members_unsubscribe_token_key" ON "recipient_list_members"("unsubscribe_token");

-- CreateIndex
CREATE UNIQUE INDEX "recipient_list_members_list_id_email_key" ON "recipient_list_members"("list_id", "email");

-- AddForeignKey
ALTER TABLE "recipient_list_members" ADD CONSTRAINT "recipient_list_members_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "recipient_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
