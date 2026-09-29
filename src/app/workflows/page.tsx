import { PageHeader } from "@/components/page-header";
import { WorkflowCanvas } from "@/components/workflow-canvas";

export default function Page() {
  return (
    <>
      <PageHeader title="Workflows" description="Design, validate, save, and publish letter workflows" />
      <main className="flex-1 p-4 md:p-6">
        <WorkflowCanvas />
      </main>
    </>
  );
}
