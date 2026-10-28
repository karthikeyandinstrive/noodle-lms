"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, PenSquare, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messagingKeys, type Contact, type Conversation } from "./types";

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Contact search: one person → direct conversation; several → named group. */
export function NewMessageDialog({ onStarted }: { onStarted: (conversationId: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Contact[]>([]);
  const [groupName, setGroupName] = useState("");
  const q = useDebounced(search.trim());

  const contacts = useQuery({
    queryKey: messagingKeys.contacts(q),
    queryFn: () => api<Contact[]>("/messages/contacts", { query: { search: q || undefined } }),
    enabled: open,
  });

  const start = useMutation({
    mutationFn: () =>
      selected.length === 1
        ? api<Conversation>("/messages/conversations", { body: { type: "direct", userId: selected[0]!.id } })
        : api<Conversation>("/messages/conversations", { body: { type: "group", name: groupName.trim(), userIds: selected.map((s) => s.id) } }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: messagingKeys.conversations });
      setOpen(false);
      setSelected([]);
      setSearch("");
      setGroupName("");
      onStarted(c.id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const toggle = (c: Contact) =>
    setSelected((cur) => (cur.some((x) => x.id === c.id) ? cur.filter((x) => x.id !== c.id) : [...cur, c]));
  const isGroup = selected.length > 1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <PenSquare aria-hidden /> {t("messages.new", "New message")}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("messages.new", "New message")}</DialogTitle>
          <DialogDescription>
            {t("messages.newHelp", "Pick one person for a private conversation, or several to start a group.")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (selected.length) start.mutate();
          }}
        >
          {selected.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t("messages.recipients", "Recipients")}>
              {selected.map((s) => (
                <li key={s.id} className="flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-sm">
                  {s.firstName} {s.lastName}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("messages.removeRecipient", "Remove {name}", { name: `${s.firstName} ${s.lastName}` })}
                    onClick={() => toggle(s)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="contact-search">{t("messages.searchPeople", "Search people")}</Label>
            <Input
              id="contact-search"
              type="search"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("messages.searchPlaceholder", "Name…")}
            />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border" role="listbox" aria-multiselectable aria-label={t("messages.contacts", "People you can message")}>
            {contacts.isPending ? (
              <p className="p-3 text-sm text-muted-foreground">{t("common.loading", "Loading…")}</p>
            ) : contacts.isError ? (
              <p className="p-3 text-sm text-destructive">{errorMessage(contacts.error)}</p>
            ) : !contacts.data?.length ? (
              <p className="p-3 text-sm text-muted-foreground">
                {t("messages.noContacts", "No one found. You can message people who share a course with you.")}
              </p>
            ) : (
              contacts.data.map((c) => {
                const on = selected.some((s) => s.id === c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    disabled={c.blocked}
                    onClick={() => toggle(c)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50",
                      on && "bg-muted",
                    )}
                  >
                    <span className="truncate">
                      {c.firstName} {c.lastName}
                      {c.blocked && <span className="ml-2 text-xs text-muted-foreground">({t("messages.blocked", "blocked")})</span>}
                    </span>
                    {on && <Check aria-hidden className="size-4 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
          {isGroup && (
            <div className="space-y-1.5">
              <Label htmlFor="group-name">{t("messages.groupName", "Group name")}</Label>
              <Input id="group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={200} required />
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!selected.length || (isGroup && !groupName.trim()) || start.isPending}>
              {isGroup ? t("messages.createGroup", "Create group") : t("messages.start", "Start conversation")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
