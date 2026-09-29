import { PageHeader } from "@/components/page-header";
import { TaskBoard } from "@/components/task-board";

export default function Page() {
  return (
    <>
      <PageHeader title="Staff tasks" description="Review tasks created by running workflows" />
      <TaskBoard />
    </>
  );
}
