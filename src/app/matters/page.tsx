import { PageHeader } from "@/components/page-header";
import { MatterList } from "@/components/matter-list";

export default function Page() {
  return (
    <>
      <PageHeader title="Matters" description="Approved legal matters" />
      <MatterList />
    </>
  );
}
