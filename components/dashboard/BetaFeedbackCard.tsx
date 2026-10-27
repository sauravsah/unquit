import { ExternalLink, MessageSquare } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const FEEDBACK_EMAIL = "sauravsahbrj@gmail.com";

/** A small, low-friction feedback channel for the public test beta. */
export function BetaFeedbackCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted">
            <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <div>
            <CardTitle>Public beta feedback</CardTitle>
            <CardDescription>Tell us what worked, what broke, or what would make Unquit more useful.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <a
          href={`mailto:${FEEDBACK_EMAIL}?subject=Unquit%20public%20beta%20feedback`}
          className="inline-flex items-center gap-2 text-sm font-medium text-brand-text underline-offset-4 hover:underline"
        >
          Email beta feedback <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
        <p className="mt-2 text-xs text-muted-foreground">Please include the page you were on and a screenshot if something looked wrong.</p>
      </CardContent>
    </Card>
  );
}
