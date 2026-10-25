"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { firebaseSignIn } from "@/lib/firebase-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function DeleteAccountCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function removeAccount() {
    setPending(true); setError(null);
    try {
      const auth = await firebaseSignIn(email, password);
      const response = await fetch("/api/account/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation, idToken: auth.idToken }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "We couldn’t delete your account.");
      window.location.assign("/login?deleted=1");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn’t delete your account.");
      setPending(false);
    }
  }

  return (
    <Card className="border-danger/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-danger"><AlertTriangle className="h-4 w-4" /> Delete account</CardTitle>
        <CardDescription>This permanently deletes your Unquit workspace, data, connected Stripe settings, and Firebase sign-in.</CardDescription>
      </CardHeader>
      <CardContent>
        {!open ? <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Delete my account</Button> : (
          <div className="max-w-md space-y-3">
            <p className="text-sm text-danger">This cannot be undone. Type <strong>DELETE</strong> and enter your current password to continue.</p>
            <Input aria-label="Type DELETE to confirm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="DELETE" autoComplete="off" />
            <Input aria-label="Current password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Current password" autoComplete="current-password" />
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
            <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => { setOpen(false); setError(null); }}>Cancel</Button><Button variant="danger" size="sm" disabled={confirmation !== "DELETE" || !password} loading={pending} onClick={removeAccount}>Permanently delete</Button></div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
