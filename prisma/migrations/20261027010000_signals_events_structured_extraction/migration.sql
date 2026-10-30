-- CreateEnum
CREATE TYPE "DateAccuracy" AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "actors" TEXT[],
ADD COLUMN     "end_date" TIMESTAMP(3),
ADD COLUMN     "end_date_accuracy" "DateAccuracy",
ADD COLUMN     "magnitude" DOUBLE PRECISION,
ADD COLUMN     "magnitude_unit" TEXT,
ADD COLUMN     "start_date" TIMESTAMP(3),
ADD COLUMN     "start_date_accuracy" "DateAccuracy";

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "actors" TEXT[],
ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "ended_at_accuracy" "DateAccuracy",
ADD COLUMN     "magnitude" DOUBLE PRECISION,
ADD COLUMN     "magnitude_unit" TEXT,
ADD COLUMN     "started_at_accuracy" "DateAccuracy";

-- CreateTable
CREATE TABLE "_SignalCountries" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_SignalCountries_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_EventCountries" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_EventCountries_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_SignalCountries_B_index" ON "_SignalCountries"("B");

-- CreateIndex
CREATE INDEX "_EventCountries_B_index" ON "_EventCountries"("B");

-- AddForeignKey
ALTER TABLE "_SignalCountries" ADD CONSTRAINT "_SignalCountries_A_fkey" FOREIGN KEY ("A") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SignalCountries" ADD CONSTRAINT "_SignalCountries_B_fkey" FOREIGN KEY ("B") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventCountries" ADD CONSTRAINT "_EventCountries_A_fkey" FOREIGN KEY ("A") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EventCountries" ADD CONSTRAINT "_EventCountries_B_fkey" FOREIGN KEY ("B") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

