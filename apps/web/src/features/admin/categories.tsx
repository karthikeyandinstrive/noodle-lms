"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorAlert, PageHeader, QueryState } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { ConfirmDialog, Field, RequireCapability } from "./shared";
import type { Category } from "./types";

const categoriesKey = ["categories"] as const;

type Node = Category & { children: Node[] };

function buildTree(items: Category[]): Node[] {
  const byId = new Map<string, Node>(items.map((c) => [c.id, { ...c, children: [] }]));
  const roots: Node[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

type Editing = { mode: "create"; parent: Category | null } | { mode: "edit"; category: Category };

function CategoryDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const initial = editing.mode === "edit" ? editing.category : null;
  const [v, setV] = useState({ name: initial?.name ?? "", description: initial?.description ?? "", sortOrder: initial?.sortOrder ?? 0, visible: initial?.visible ?? true });
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: v.name, description: v.description || null, sortOrder: v.sortOrder, visible: v.visible };
      return editing.mode === "edit"
        ? api(`/categories/${editing.category.id}`, { method: "PATCH", body })
        : api("/categories", { body: { ...body, parentId: editing.parent?.id ?? null } });
    },
    onSuccess: () => {
      toast.success(t("admin.categories.saved", "Category saved"));
      void qc.invalidateQueries({ queryKey: categoriesKey });
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing.mode === "edit"
              ? t("admin.categories.editCategory", "Edit category")
              : editing.parent
                ? t("admin.categories.newSubcategoryOf", "New subcategory of {name}", { name: editing.parent.name })
                : t("admin.categories.newCategory", "New category")}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          {error ? <ErrorAlert error={error} /> : null}
          <Field id="cat-name" label={t("common.name", "Name")}>
            <Input id="cat-name" required maxLength={255} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </Field>
          <Field id="cat-desc" label={t("common.description", "Description")}>
            <Textarea id="cat-desc" rows={3} maxLength={5000} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
          </Field>
          <Field id="cat-order" label={t("admin.categories.sortOrder", "Sort order")} hint={t("admin.categories.sortOrderHint", "Lower numbers are listed first.")}>
            <Input id="cat-order" type="number" step={1} value={v.sortOrder} onChange={(e) => setV({ ...v, sortOrder: Number.parseInt(e.target.value || "0", 10) })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch aria-label={t("common.visible", "Visible")} checked={v.visible} onCheckedChange={(visible) => setV({ ...v, visible })} />{" "}
            <span aria-hidden>{t("common.visible", "Visible")}</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t("common.saving", "Saving…") : t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TreeItem({ node, depth, onEdit, onAdd, onDelete }: { node: Node; depth: number; onEdit: (c: Category) => void; onAdd: (c: Category) => void; onDelete: (c: Category) => void }) {
  const t = useT();
  return (
    <li>
      <div className="flex items-center gap-2 border-b py-2" style={{ paddingLeft: `${Math.min(depth, 6) * 1.25}rem` }}>
        <div className="min-w-0 flex-1">
          <span className="font-medium">{node.name}</span>
          {!node.visible && (
            <Badge variant="outline" className="ml-2 gap-1">
              <EyeOff aria-hidden className="size-3" /> {t("common.hidden", "Hidden")}
            </Badge>
          )}
          {node.description && <p className="truncate text-xs text-muted-foreground">{node.description}</p>}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t("admin.categories.addSubcategory", "Add subcategory to {name}", { name: node.name })} onClick={() => onAdd(node)}>
          <FolderPlus aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("admin.shared.editName", "Edit {name}", { name: node.name })} onClick={() => onEdit(node)}>
          <Pencil aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("admin.shared.deleteName", "Delete {name}", { name: node.name })} onClick={() => onDelete(node)}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeItem key={c.id} node={c} depth={depth + 1} onEdit={onEdit} onAdd={onAdd} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CategoriesAdmin() {
  const t = useT();
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: categoriesKey, queryFn: () => api<Category[]>("/categories") });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/categories/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.categories.deleted", "Category deleted"));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: categoriesKey });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const tree = categories.data ? buildTree(categories.data) : [];
  const hasChildren = (c: Category) => categories.data?.some((x) => x.parentId === c.id) ?? false;

  return (
    <RequireCapability capability="category:manage">
      <PageHeader
        title={t("admin.categories.title", "Course categories")}
        description={t("admin.categories.description", "Organize courses in a tree. Permissions granted on a category apply to all courses inside it.")}
        actions={
          <Button onClick={() => setEditing({ mode: "create", parent: null })}>
            <Plus aria-hidden /> {t("admin.categories.newCategory", "New category")}
          </Button>
        }
      />
      <QueryState query={categories}>
        {tree.length === 0 ? (
          <EmptyState title={t("admin.categories.empty", "No categories yet")} />
        ) : (
          <ul className="rounded-xl border px-3" aria-label={t("admin.categories.tree", "Category tree")}>
            {tree.map((n) => (
              <TreeItem
                key={n.id}
                node={n}
                depth={0}
                onEdit={(category) => setEditing({ mode: "edit", category })}
                onAdd={(parent) => setEditing({ mode: "create", parent })}
                onDelete={(c) => (hasChildren(c) ? toast.error(t("admin.categories.deleteChildrenFirst", "Delete its subcategories first")) : setDeleting(c))}
              />
            ))}
          </ul>
        )}
      </QueryState>
      {editing && <CategoryDialog editing={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("admin.shared.deleteTitle", "Delete {name}?", { name: deleting?.name ?? "" })}
        description={t("admin.categories.deleteDescription", "Only empty categories can be deleted: move or delete its courses first.")}
        confirmLabel={t("common.delete", "Delete")}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </RequireCapability>
  );
}
