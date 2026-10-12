import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function DashboardNotFound() {
  return (
    <Card>
      <EmptyState
        art="inbox"
        title="This page doesn't exist"
        description="The link may be old. Press ⌘K to jump anywhere."
        action={
          <Button asChild variant="secondary">
            <Link href="/dashboard">Back to overview</Link>
          </Button>
        }
      />
    </Card>
  );
}
