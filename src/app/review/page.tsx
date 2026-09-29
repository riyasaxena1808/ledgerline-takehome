import { PageHeader } from "@/components/page-header";
import { ReviewQueue } from "@/components/review-queue";

export default function Page() {
  return (
    <>
      <PageHeader title="Review" description="Review and decide every imported row" />
      <ReviewQueue />
    </>
  );
}
