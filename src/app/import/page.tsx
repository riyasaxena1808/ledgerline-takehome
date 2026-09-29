
import { PageHeader } from "@/components/page-header";
import { MatterCsvUpload } from "@/components/matter-csv-upload";

export default function Page() {
  return (
    <>
      <PageHeader
        title="Import"
        description="Upload a CSV of matters"
      />
      <main className="flex flex-1 justify-center p-6">
        <MatterCsvUpload />
      </main>
    </>
  );
}
