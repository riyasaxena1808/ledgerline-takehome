import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { navGroups } from "@/lib/nav";

export default function Home() {
  return (
    <>
      <PageHeader title="Overview" />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 p-6 md:p-10">
        <div className="max-w-2xl space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">
            Import, review, and process matters
          </h2>
          <p className="text-muted-foreground">
            Start with a CSV import, review every row, then design and publish a
            letter workflow for approved matters. Runs are advanced by the
            separate workflow worker. The assessment and setup guide are in the
            README and <code>docs/IMPLEMENTATION_GUIDE.md</code>.
          </p>
        </div>

        {navGroups.map((group) => (
          <section key={group.label} className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              {group.label}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => (
                <Link key={item.href} href={item.href} className="group">
                  <Card className="h-full transition-colors group-hover:bg-muted/50">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <item.icon className="size-5 text-muted-foreground" />
                        <Badge variant="secondary">{item.phase}</Badge>
                      </div>
                      <CardTitle className="flex items-center gap-1">
                        {item.title}
                        <ArrowRightIcon className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                      </CardTitle>
                      <CardDescription>{item.description}</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
