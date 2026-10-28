"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Category } from "./api";

type GiftProblem = { index: number | null; line: number; title: string | null; message: string };
type ImportResult = { imported: number; categoriesCreated: number; warnings: GiftProblem[] };

/** Downloads the category as a GIFT text file (GET …/export.gift). */
export async function downloadGift(category: Category, courseId: string) {
  const res = await fetch(`/api/v1/question-bank/categories/${category.id}/export.gift?courseId=${encodeURIComponent(courseId)}`, { credentials: "same-origin" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? res.statusText);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `${category.name.replace(/[^\w-]+/g, "_")}.gift.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function ProblemList({ items, label }: { items: GiftProblem[]; label: string }) {
  const t = useT();
  return (
    <ul aria-label={label} className="max-h-48 space-y-1 overflow-y-auto text-xs">
      {items.map((p, i) => (
        <li key={i}>
          <span className="font-medium">
            {t("questionbank.gift.lineRef", "Line {line}", { line: p.line })}
            {p.title ? ` · ${p.title}` : ""}:
          </span>{" "}
          {p.message}
        </li>
      ))}
    </ul>
  );
}

/** Import questions from GIFT text (file or paste). All-or-nothing; per-question errors are listed. */
export function GiftImportDialog({ category, open, onOpenChange, onImported }: { category: Category; open: boolean; onOpenChange: (o: boolean) => void; onImported: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [createCategories, setCreateCategories] = useState(false);
  const [warnings, setWarnings] = useState<GiftProblem[]>([]);

  const run = useMutation({
    mutationFn: () => api<ImportResult>(`/question-bank/categories/${category.id}/import-gift`, { body: { text, createCategories } }),
    onSuccess: (r) => {
      toast.success(t("questionbank.gift.imported", "{count} question(s) imported", { count: r.imported }));
      if (r.categoriesCreated) toast.info(t("questionbank.gift.categoriesCreated", "{count} sub-categories created", { count: r.categoriesCreated }));
      onImported();
      if (r.warnings.length) {
        setWarnings(r.warnings);
        setText("");
        setFileName(null);
      } else {
        onOpenChange(false);
      }
    },
  });
  const problems = run.error instanceof ApiError && Array.isArray(run.error.details) ? (run.error.details as GiftProblem[]) : null;

  async function pickFile(file: File) {
    try {
      setText(await file.text());
      setFileName(file.name);
      setWarnings([]);
      run.reset();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("questionbank.gift.importTitle", "Import GIFT questions")}</DialogTitle>
          <DialogDescription>
            {t(
              "questionbank.gift.importHelp",
              "Questions are added to “{category}”. Supported: multiple choice, true/false, short answer, numerical, matching and essay. If any question can't be imported, nothing is imported.",
              { category: category.name },
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          id="gift-import"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setWarnings([]);
            run.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="gift-file">{t("questionbank.gift.file", "GIFT file")}</Label>
            <input
              id="gift-file"
              type="file"
              accept=".gift,.txt,text/plain"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickFile(f);
                e.target.value = "";
              }}
            />
            {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gift-text">{t("questionbank.gift.text", "…or paste GIFT text")}</Label>
            <Textarea
              id="gift-text"
              rows={8}
              className="font-mono text-xs"
              placeholder={"::Capital::What is the capital of France? {=Paris ~Lyon ~Marseille}"}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
              }}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={createCategories} onChange={(e) => setCreateCategories(e.target.checked)} />
            <span>
              {t("questionbank.gift.createCategories", "Create sub-categories from $CATEGORY lines")}
              <span className="block text-xs text-muted-foreground">{t("questionbank.gift.createCategoriesHelp", "Otherwise $CATEGORY lines are ignored.")}</span>
            </span>
          </label>
          {run.isError &&
            (problems?.length ? (
              <Alert variant="destructive">
                <AlertTitle>{errorMessage(run.error)}</AlertTitle>
                <AlertDescription>
                  <ProblemList items={problems} label={t("questionbank.gift.errors", "Import errors")} />
                </AlertDescription>
              </Alert>
            ) : (
              <ErrorAlert error={run.error} />
            ))}
          {warnings.length > 0 && (
            <Alert>
              <AlertTitle>{t("questionbank.gift.warningsTitle", "Imported with warnings")}</AlertTitle>
              <AlertDescription>
                <ProblemList items={warnings} label={t("questionbank.gift.warnings", "Import warnings")} />
              </AlertDescription>
            </Alert>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {warnings.length ? t("common.close", "Close") : t("common.cancel", "Cancel")}
          </Button>
          <Button type="submit" form="gift-import" disabled={!text.trim() || run.isPending}>
            {run.isPending ? t("questionbank.gift.importing", "Importing…") : t("questionbank.gift.import", "Import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
