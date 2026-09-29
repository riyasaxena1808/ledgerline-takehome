import { PageHeader } from "@/components/page-header";
import { RunConsole } from "@/components/run-console";

export default function Page() {
  return (
    <>
      <PageHeader title="Runs" description="Start workflows and follow each matter's progress" />
      <RunConsole />
    </>
  );
}
