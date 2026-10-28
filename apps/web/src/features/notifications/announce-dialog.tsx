"use client";

import { useMutation } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";

/** Sends an announcement notification to every participant (needs notification:send). */
export function AnnounceDialog({ courseId }: { courseId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () => api<{ sent: number }>(`/notifications/courses/${courseId}/announce`, { body: { title, body: body || undefined } }),
    onSuccess: (r) => {
      toast.success(`Announcement sent to ${r.sent} participant${r.sent === 1 ? "" : "s"}`);
      setTitle("");
      setBody("");
      setOpen(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Megaphone /> Announce
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send an announcement</DialogTitle>
          <DialogDescription>Every active participant receives a notification (and an email, unless they turned it off).</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="announce-title">Title</Label>
            <Input id="announce-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="announce-body">Message</Label>
            <Textarea id="announce-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={send.isPending || !title.trim()}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
