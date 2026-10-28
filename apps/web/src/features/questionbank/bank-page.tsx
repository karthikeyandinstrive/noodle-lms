"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, FolderPlus, History, MoreHorizontal, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorAlert, HtmlContent, QueryState, formatDate } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCourse } from "@/features/courses/use-course";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { selectClass } from "../assignment/form-utils";
import { TYPE_LABEL, type QuestionType } from "../quiz/api";
import { bankKeys, useBankPermissions, useCategories, useQuestions, useVersions, type Category } from "./api";
import { GiftImportDialog, downloadGift } from "./gift";
import { QuestionEditorDialog } from "./question-editor";

export function QuestionBankPage() {
  const { courseId, can, isPending } = useCourse();
  const perms = useBankPermissions(courseId);
  const cats = useCategories(courseId);
  const qc = useQueryClient();
  const [chosen, setCategoryId] = useState<string | null>(null);
  const [newCat, setNewCat] = useState<{ shared: boolean } | null>(null);
  // Fall back to the first category when nothing (or a deleted one) is selected.
  const categoryId = chosen && cats.data?.some((c) => c.id === chosen) ? chosen : (cats.data?.[0]?.id ?? null);

  if (!isPending && !can("question:manage")) return <EmptyState title="You cannot manage this question bank" />;

  const courseCats = cats.data?.filter((c) => c.courseId) ?? [];
  const sharedCats = cats.data?.filter((c) => !c.courseId) ?? [];
  const canShare = perms.data?.shared ?? false;
  const current = cats.data?.find((c) => c.id === categoryId) ?? null;

  return (
    <QueryState query={cats}>
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-4" aria-label="Question categories">
          <CategoryGroup
            title="This course"
            items={courseCats}
            selected={categoryId}
            onSelect={setCategoryId}
            onAdd={() => setNewCat({ shared: false })}
            canAdd
          />
          {(sharedCats.length > 0 || canShare) && (
            <CategoryGroup
              title="Shared"
              items={sharedCats}
              selected={categoryId}
              onSelect={setCategoryId}
              onAdd={() => setNewCat({ shared: true })}
              canAdd={canShare}
            />
          )}
        </aside>
        <div className="min-w-0">
          {current ? (
            <CategoryQuestions
              key={current.id}
              courseId={courseId}
              category={current}
              onDeleted={() => {
                setCategoryId(null);
                void qc.invalidateQueries({ queryKey: bankKeys.all });
              }}
            />
          ) : (
            <EmptyState
              title="No categories yet"
              description="Create a category to start adding questions."
              action={
                <Button onClick={() => setNewCat({ shared: false })}>
                  <FolderPlus /> New category
                </Button>
              }
            />
          )}
        </div>
      </div>
      {newCat && (
        <CategoryDialog
          courseId={newCat.shared ? null : courseId}
          onClose={(id) => {
            setNewCat(null);
            if (id) setCategoryId(id);
          }}
        />
      )}
    </QueryState>
  );
}

function CategoryGroup({
  title,
  items,
  selected,
  onSelect,
  onAdd,
  canAdd,
}: {
  title: string;
  items: Category[];
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  canAdd: boolean;
}) {
  // Indent children under their parent.
  const depthOf = (c: Category): number => {
    let d = 0;
    let p = c.parentId;
    while (p && d < 10) {
      d++;
      p = items.find((x) => x.id === p)?.parentId ?? null;
    }
    return d;
  };
  const ordered = [...items].sort((a, b) => path(a, items).localeCompare(path(b, items)));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
        {canAdd && (
          <Button variant="ghost" size="icon-xs" aria-label={`New ${title.toLowerCase()} category`} onClick={onAdd}>
            <Plus />
          </Button>
        )}
      </div>
      {ordered.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">No categories</p>
      ) : (
        <ul className="space-y-0.5">
          {ordered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={c.id === selected ? "true" : undefined}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  c.id === selected && "bg-muted font-medium",
                )}
                style={{ paddingLeft: `${0.5 + depthOf(c) * 0.75}rem` }}
              >
                <span className="truncate">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.questionCount}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function path(c: Category, all: Category[]): string {
  const parts = [c.name];
  let p = c.parentId;
  for (let i = 0; p && i < 10; i++) {
    const parent = all.find((x) => x.id === p);
    if (!parent) break;
    parts.unshift(parent.name);
    p = parent.parentId;
  }
  return parts.join(" / ");
}

function CategoryDialog({ courseId, parentId, onClose }: { courseId: string | null; parentId?: string | null; onClose: (createdId?: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api<Category>("/question-bank/categories", { body: { courseId, parentId: parentId ?? null, name } }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: bankKeys.all });
      onClose(c.id);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentId ? "New sub-category" : courseId ? "New category" : "New shared category"}</DialogTitle>
        </DialogHeader>
        <form
          id="cat-form"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-2"
        >
          <Label htmlFor="cat-name">Name</Label>
          <Input id="cat-name" required maxLength={255} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          {create.isError && <ErrorAlert error={create.error} />}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button type="submit" form="cat-form" disabled={!name.trim() || create.isPending}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoryQuestions({ courseId, category, onDeleted }: { courseId: string; category: Category; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<QuestionType | "">("");
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [subCat, setSubCat] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [giftImport, setGiftImport] = useState(false);
  const t = useT();
  const qs = useQuestions(category.id, courseId, { page, search: search || undefined, type: type || undefined });
  const refresh = () => qc.invalidateQueries({ queryKey: bankKeys.all });

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? Quizzes already using it keep working.`)) return;
    try {
      await api(`/question-bank/questions/${id}`, { method: "DELETE" });
      toast.success("Question deleted");
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function exportJson() {
    try {
      const data = await api(`/question-bank/categories/${category.id}/export`, { query: { courseId } });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${category.name.replace(/[^\w-]+/g, "_")}.questions.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function importJson(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as { questions?: unknown[] } | unknown[];
      const questions = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(questions) || !questions.length) throw new Error("No questions found in this file");
      const r = await api<{ imported: number }>(`/question-bank/categories/${category.id}/import`, { body: { questions } });
      toast.success(`${r.imported} question${r.imported === 1 ? "" : "s"} imported`);
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function deleteCategory() {
    if (!window.confirm(`Delete the category "${category.name}"?`)) return;
    try {
      await api(`/question-bank/categories/${category.id}`, { method: "DELETE" });
      toast.success("Category deleted");
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{category.name}</h2>
          <p className="text-xs text-muted-foreground">
            {category.courseId ? "Course category" : "Shared with every course"} · {category.questionCount} question{category.questionCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex gap-2">
          {category.canEdit && (
            <Button onClick={() => setEditing({ id: null })}>
              <Plus /> New question
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Category actions" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void exportJson()}>
                <Download /> Export JSON
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void downloadGift(category, courseId).catch((err) => toast.error(errorMessage(err)))}>
                <FileText /> {t("questionbank.gift.export", "Export GIFT")}
              </DropdownMenuItem>
              {category.canEdit && (
                <>
                  <DropdownMenuItem onClick={() => fileRef.current?.click()}>
                    <Upload /> Import JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setGiftImport(true)}>
                    <Upload /> {t("questionbank.gift.importMenu", "Import GIFT…")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSubCat(true)}>
                    <FolderPlus /> New sub-category
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRenaming(true)}>
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => void deleteCategory()}>
                    <Trash2 /> Delete category
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {giftImport && <GiftImportDialog category={category} open onOpenChange={setGiftImport} onImported={() => void refresh()} />}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importJson(f);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_200px]">
        <Input
          aria-label="Search questions"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Filter by type"
          className={selectClass}
          value={type}
          onChange={(e) => {
            setType(e.target.value as QuestionType | "");
            setPage(1);
          }}
        >
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <QueryState query={qs}>
        {qs.data &&
          (qs.data.items.length === 0 ? (
            <EmptyState title="No questions" description={search || type ? "Try another search." : "Add the first question to this category."} />
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden sm:table-cell">Type</TableHead>
                    <TableHead className="hidden md:table-cell">Version</TableHead>
                    <TableHead className="hidden md:table-cell">Updated</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {qs.data.items.map((q) => (
                    <TableRow key={q.id}>
                      <TableCell className="max-w-64">
                        <div className="truncate font-medium">{q.name}</div>
                        <div className="text-xs text-muted-foreground sm:hidden">{TYPE_LABEL[q.type]}</div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="outline">{TYPE_LABEL[q.type]}</Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">v{q.latestVersion}</TableCell>
                      <TableCell className="hidden md:table-cell">{formatDate(q.updatedAt, false)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {category.canEdit && (
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${q.name}`} onClick={() => setEditing({ id: q.id })}>
                            <Pencil />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon-sm" aria-label={`Version history of ${q.name}`} onClick={() => setHistory(q.id)}>
                          <History />
                        </Button>
                        {category.canEdit && (
                          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${q.name}`} onClick={() => void remove(q.id, q.name)}>
                            <Trash2 />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
      </QueryState>

      {qs.data && qs.data.total > qs.data.pageSize && (
        <div className="flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {page} of {Math.ceil(qs.data.total / qs.data.pageSize)}
          </span>
          <Button variant="outline" size="sm" disabled={page * qs.data.pageSize >= qs.data.total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}

      {editing && <QuestionEditorDialog courseId={courseId} categoryId={category.id} questionId={editing.id} onClose={() => setEditing(null)} />}
      {history && <VersionHistoryDialog courseId={courseId} questionId={history} onClose={() => setHistory(null)} />}
      {renaming && <RenameDialog category={category} onClose={() => setRenaming(false)} />}
      {subCat && <CategoryDialog courseId={category.courseId} parentId={category.id} onClose={() => setSubCat(false)} />}
    </div>
  );
}

function RenameDialog({ category, onClose }: { category: Category; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(category.name);
  const rename = useMutation({
    mutationFn: () => api(`/question-bank/categories/${category.id}`, { method: "PATCH", body: { name } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankKeys.all });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename category</DialogTitle>
        </DialogHeader>
        <form
          id="rename-form"
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <Label htmlFor="rename">Name</Label>
          <Input id="rename" required maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
          {rename.isError && <ErrorAlert error={rename.error} />}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rename-form" disabled={!name.trim() || rename.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionHistoryDialog({ courseId, questionId, onClose }: { courseId: string; questionId: string; onClose: () => void }) {
  const versions = useVersions(questionId, courseId);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
        </DialogHeader>
        <QueryState query={versions}>
          <ol className="space-y-2">
            {versions.data?.map((v, i) => (
              <li key={v.id} className="rounded-lg border">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left text-sm"
                  aria-expanded={open === v.version}
                  onClick={() => setOpen(open === v.version ? null : v.version)}
                >
                  <span className="font-medium">
                    v{v.version} · {v.name} {i === 0 && <Badge className="ml-1">Current</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(v.createdAt)}
                    {v.createdBy && ` · ${v.createdBy.firstName} ${v.createdBy.lastName}`}
                  </span>
                </button>
                {open === v.version && (
                  <div className="space-y-2 border-t p-3 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {TYPE_LABEL[v.type]} · default mark {v.defaultMark}
                    </p>
                    <HtmlContent html={v.text} />
                    <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(v.data, null, 2)}</pre>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}
