"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileText, ImageIcon, Plus, QrCode, Trash2, Type } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/common";
import { FileInput } from "@/components/file-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, errorMessage, fileUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConfirmButton, NativeSelectClass, openInNewTab } from "./shared";
import { PLACEHOLDER_HELP, renderPlaceholders, SAMPLE_VALUES, type CertificateElement, type CertificateTemplate } from "./types";

const PAGE = { landscape: { w: 297, h: 210 }, portrait: { w: 210, h: 297 } } as const;
const PT_TO_MM = 25.4 / 72;
const BOLD_FROM_PT = 24;

/** The PDF is rendered with DejaVu Sans (regular/bold); the API serves the same files so the preview matches. */
const CERT_FONT = '"LMS Certificate Sans"';
const CERT_FONT_CSS = `
@font-face { font-family: ${CERT_FONT}; font-weight: 400; font-display: swap; src: url("/api/v1/certificates/fonts/DejaVuSans.ttf") format("truetype"); }
@font-face { font-family: ${CERT_FONT}; font-weight: 700; font-display: swap; src: url("/api/v1/certificates/fonts/DejaVuSans-Bold.ttf") format("truetype"); }
`;

type Draft = Pick<CertificateTemplate, "name" | "orientation" | "backgroundFileId" | "elements">;

const STARTER: CertificateElement[] = [
  { type: "text", x: 148.5, y: 35, fontSize: 36, align: "center", color: "#1e293b", text: "Certificate of Completion" },
  { type: "text", x: 148.5, y: 65, fontSize: 14, align: "center", color: "#475569", text: "This certifies that" },
  { type: "text", x: 148.5, y: 80, fontSize: 30, align: "center", color: "#0f172a", text: "{{fullname}}" },
  { type: "text", x: 148.5, y: 110, fontSize: 14, align: "center", color: "#475569", text: "has successfully completed" },
  { type: "text", x: 148.5, y: 122, fontSize: 20, align: "center", color: "#0f172a", text: "{{coursename}}" },
  { type: "text", x: 25, y: 175, fontSize: 11, align: "left", color: "#475569", text: "Issued {{date}} by {{orgname}}\nVerification code: {{code}}" },
  { type: "qrcode", x: 247, y: 155, width: 28 },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Live, scaled HTML approximation of the PDF (mm → % of page; pt → px via the measured width). */
function Preview({
  draft,
  selected,
  onSelect,
  onMove,
}: {
  draft: Draft;
  selected: number | null;
  onSelect: (i: number) => void;
  onMove: (i: number, x: number, y: number) => void;
}) {
  const page = PAGE[draft.orientation];
  const box = useRef<HTMLDivElement>(null);
  const [pxPerMm, setPxPerMm] = useState(2);
  const drag = useRef<{ i: number; startX: number; startY: number; elX: number; elY: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPxPerMm(el.clientWidth / page.w));
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.w]);

  return (
    <div
      ref={box}
      className="relative w-full touch-none overflow-hidden rounded-lg border bg-white text-left shadow-sm select-none"
      style={{ aspectRatio: `${page.w} / ${page.h}` }}
      aria-label="Certificate preview"
      role="img"
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        onMove(d.i, round1(clamp(d.elX + (e.clientX - d.startX) / pxPerMm, 0, page.w)), round1(clamp(d.elY + (e.clientY - d.startY) / pxPerMm, 0, page.h)));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      <style>{CERT_FONT_CSS}</style>
      {draft.backgroundFileId && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fileUrl(draft.backgroundFileId, true)} alt="" className="pointer-events-none absolute inset-0 size-full object-fill" />
      )}
      {draft.elements.map((el, i) => {
        const startDrag = (e: React.PointerEvent) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          onSelect(i);
          drag.current = { i, startX: e.clientX, startY: e.clientY, elX: el.x, elY: el.y };
        };
        const ring = selected === i ? "outline outline-2 outline-offset-2 outline-primary" : "hover:outline hover:outline-1 hover:outline-primary/50";
        if (el.type === "text") {
          const fontSize = el.fontSize ?? 14;
          const align = el.align ?? "left";
          const anchored = !el.width;
          return (
            <div
              key={i}
              onPointerDown={startDrag}
              className={cn("absolute cursor-move leading-[1.2] whitespace-pre-wrap", ring)}
              style={{
                left: `${(el.x / page.w) * 100}%`,
                top: `${(el.y / page.h) * 100}%`,
                width: el.width ? `${(el.width / page.w) * 100}%` : undefined,
                transform: anchored ? (align === "center" ? "translateX(-50%)" : align === "right" ? "translateX(-100%)" : undefined) : undefined,
                whiteSpace: anchored ? "pre" : "pre-wrap",
                textAlign: align,
                fontSize: fontSize * PT_TO_MM * pxPerMm,
                fontFamily: `${CERT_FONT}, "DejaVu Sans", Verdana, sans-serif`,
                fontWeight: fontSize >= BOLD_FROM_PT ? 700 : 400,
                color: el.color ?? "#1a1a1a",
              }}
            >
              {renderPlaceholders(el.text ?? "", SAMPLE_VALUES) || " "}
            </div>
          );
        }
        const w = el.width ?? (el.type === "qrcode" ? 25 : 40);
        return (
          <div
            key={i}
            onPointerDown={startDrag}
            className={cn("absolute cursor-move", ring)}
            style={{ left: `${(el.x / page.w) * 100}%`, top: `${(el.y / page.h) * 100}%`, width: `${(w / page.w) * 100}%` }}
          >
            {el.type === "qrcode" ? (
              <div className="flex aspect-square w-full items-center justify-center border border-dashed border-slate-400 bg-white/70 text-slate-500">
                <QrCode className="size-1/2" aria-hidden />
              </div>
            ) : el.fileId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(el.fileId, true)} alt="" className="pointer-events-none w-full" />
            ) : (
              <div className="flex aspect-[4/3] w-full items-center justify-center border border-dashed border-slate-400 text-slate-500">
                <ImageIcon className="size-1/3" aria-hidden />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NumberField({ id, label, value, onChange, min = 0, max = 297, step = 0.5, placeholder }: {
  id: string;
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : clamp(Number(e.target.value), min, max))}
      />
    </div>
  );
}

function ElementEditor({ el, index, onChange }: { el: CertificateElement; index: number; onChange: (el: CertificateElement) => void }) {
  const set = <K extends keyof CertificateElement>(k: K, v: CertificateElement[K]) => {
    const next = { ...el, [k]: v };
    if (v === undefined) delete next[k];
    onChange(next);
  };
  const p = `el-${index}`;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <NumberField id={`${p}-x`} label="X (mm)" value={el.x} onChange={(v) => set("x", v ?? 0)} />
        <NumberField id={`${p}-y`} label="Y (mm)" value={el.y} onChange={(v) => set("y", v ?? 0)} />
        <NumberField id={`${p}-w`} label={el.type === "text" ? "Box width (mm)" : "Width (mm)"} value={el.width} min={1} placeholder={el.type === "text" ? "Auto" : undefined} onChange={(v) => set("width", v)} />
        {el.type === "text" && <NumberField id={`${p}-fs`} label="Font size (pt)" value={el.fontSize} min={4} max={200} step={1} placeholder="14" onChange={(v) => set("fontSize", v)} />}
      </div>
      {el.type === "text" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${p}-align`} className="text-xs">
                Alignment
              </Label>
              <select id={`${p}-align`} className={NativeSelectClass} value={el.align ?? "left"} onChange={(e) => set("align", e.target.value as CertificateElement["align"])}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${p}-color`} className="text-xs">
                Colour
              </Label>
              <div className="flex items-center gap-2">
                <input
                  id={`${p}-color`}
                  type="color"
                  className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-background"
                  value={/^#[0-9a-f]{6}$/i.test(el.color ?? "") ? el.color : "#1a1a1a"}
                  onChange={(e) => set("color", e.target.value)}
                />
                <span className="font-mono text-xs text-muted-foreground">{el.color ?? "#1a1a1a"}</span>
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${p}-text`} className="text-xs">
              Text
            </Label>
            <Textarea id={`${p}-text`} rows={2} maxLength={2000} value={el.text ?? ""} onChange={(e) => set("text", e.target.value)} />
          </div>
        </>
      )}
      {el.type === "image" && (
        <div className="space-y-1">
          <Label className="text-xs">Image (PNG or JPEG)</Label>
          <FileInput value={el.fileId ?? null} accept="image/png,image/jpeg" onChange={(id) => set("fileId", id ?? undefined)} />
        </div>
      )}
      {el.type === "qrcode" && <p className="text-xs text-muted-foreground">Links to the public verification page of each certificate.</p>}
    </div>
  );
}

const ICONS = { text: Type, image: ImageIcon, qrcode: QrCode } as const;

export function TemplateEditor({ template }: { template?: CertificateTemplate }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() =>
    template
      ? { name: template.name, orientation: template.orientation, backgroundFileId: template.backgroundFileId, elements: template.elements }
      : { name: "", orientation: "landscape", backgroundFileId: null, elements: STARTER },
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const setEl = (i: number, el: CertificateElement) => setDraft((d) => ({ ...d, elements: d.elements.map((x, j) => (j === i ? el : x)) }));
  const page = PAGE[draft.orientation];

  const save = useMutation({
    mutationFn: () =>
      template
        ? api<CertificateTemplate>(`/certificates/templates/${template.id}`, { method: "PATCH", body: draft })
        : api<CertificateTemplate>("/certificates/templates", { body: draft }),
    onSuccess: (t) => {
      toast.success("Template saved");
      void qc.invalidateQueries({ queryKey: ["certificates", "templates"] });
      if (!template) router.replace(`/admin/certificates/${t.id}`);
    },
  });

  async function previewPdf() {
    setPreviewing(true);
    try {
      await openInNewTab(async () => {
        const res = await fetch("/api/v1/certificates/templates/preview", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orientation: draft.orientation, backgroundFileId: draft.backgroundFileId, elements: draft.elements }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "Preview failed");
        }
        return URL.createObjectURL(await res.blob());
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  const add = (type: CertificateElement["type"]) => {
    const el: CertificateElement =
      type === "text"
        ? { type, x: page.w / 2, y: page.h / 2, fontSize: 16, align: "center", color: "#1a1a1a", text: "New text" }
        : type === "qrcode"
          ? { type, x: page.w - 45, y: page.h - 45, width: 25 }
          : { type, x: 20, y: 20, width: 40 };
    setDraft((d) => ({ ...d, elements: [...d.elements, el] }));
    setSelected(draft.elements.length);
  };
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.elements.length) return d;
      const els = [...d.elements];
      [els[i], els[j]] = [els[j]!, els[i]!];
      setSelected(j);
      return { ...d, elements: els };
    });

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {save.error ? <ErrorAlert error={save.error} title="Could not save the template" /> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Preview draft={draft} selected={selected} onSelect={setSelected} onMove={(i, x, y) => setEl(i, { ...draft.elements[i]!, x, y })} />
          <p className="text-xs text-muted-foreground">
            Drag elements to move them. The preview approximates the PDF; use <strong>Preview PDF</strong> for the exact output. Placeholders:{" "}
            {PLACEHOLDER_HELP.map((p) => (
              <code key={p} className="mr-1 rounded bg-muted px-1">
                {p}
              </code>
            ))}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save template"}
            </Button>
            <Button type="button" variant="outline" disabled={previewing} onClick={previewPdf}>
              <FileText /> {previewing ? "Rendering…" : "Preview PDF"}
            </Button>
            {template && (
              <ConfirmButton
                title="Delete this template?"
                description="Templates used by certificate activities cannot be deleted."
                confirmLabel="Delete"
                variant="destructive"
                onConfirm={async () => {
                  try {
                    await api(`/certificates/templates/${template.id}`, { method: "DELETE" });
                    toast.success("Template deleted");
                    void qc.invalidateQueries({ queryKey: ["certificates", "templates"] });
                    router.replace("/admin/certificates");
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Trash2 /> Delete
              </ConfirmButton>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Template</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Name</Label>
                <Input id="tpl-name" required maxLength={255} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-orientation">Orientation (A4)</Label>
                <select
                  id="tpl-orientation"
                  className={NativeSelectClass}
                  value={draft.orientation}
                  onChange={(e) => setDraft({ ...draft, orientation: e.target.value as Draft["orientation"] })}
                >
                  <option value="landscape">Landscape (297 × 210 mm)</option>
                  <option value="portrait">Portrait (210 × 297 mm)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Background image (PNG or JPEG)</Label>
                <FileInput value={draft.backgroundFileId} accept="image/png,image/jpeg" onChange={(id) => setDraft({ ...draft, backgroundFileId: id })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Elements</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => add("text")}>
                  <Plus /> Text
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => add("image")}>
                  <Plus /> Image
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => add("qrcode")} disabled={draft.elements.some((e) => e.type === "qrcode")}>
                  <Plus /> QR code
                </Button>
              </div>
              {!draft.elements.length && <p className="text-sm text-muted-foreground">Add text, images or a verification QR code.</p>}
              <ul className="space-y-2">
                {draft.elements.map((el, i) => {
                  const Icon = ICONS[el.type];
                  const open = selected === i;
                  const label = el.type === "text" ? (el.text || "Text").split("\n")[0]!.slice(0, 40) : el.type === "qrcode" ? "QR code" : "Image";
                  return (
                    <li key={i} className={cn("rounded-lg border", open && "border-primary")}>
                      <div className="flex items-center gap-1 p-2">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          aria-expanded={open}
                          onClick={() => setSelected(open ? null : i)}
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">{label}</span>
                        </button>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label="Move down" disabled={i === draft.elements.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${label}`}
                          onClick={() => {
                            setDraft((d) => ({ ...d, elements: d.elements.filter((_, j) => j !== i) }));
                            setSelected(null);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      {open && (
                        <div className="border-t p-3">
                          <ElementEditor el={el} index={i} onChange={(next) => setEl(i, next)} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </form>
  );
}
