"use client";

import Link from "@tiptap/extension-link";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading2, Italic, Link2, List, ListOrdered, Quote, Redo2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Rich-text (HTML) editor for user-authored content. Output is HTML that the
 * API sanitizes on write; render saved content with <HtmlContent>.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  id,
  minHeight = 120,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  id?: string;
  minHeight?: number;
  className?: string;
  "aria-label"?: string;
}) {
  const t = useT();
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
      Link.configure({ openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"], HTMLAttributes: { rel: "noopener noreferrer" } }),
    ],
    content: value,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        role: "textbox",
        "aria-multiline": "true",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
        class: "prose prose-sm max-w-none dark:prose-invert focus:outline-none px-3 py-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-primary [&_a]:underline",
        style: `min-height:${minHeight}px`,
      },
    },
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
  });

  // Keep in sync when the value is replaced from outside (e.g. form reset).
  useEffect(() => {
    if (editor && value !== editor.getHTML() && !(value === "" && editor.isEmpty)) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            h2: e.isActive("heading", { level: 2 }),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            quote: e.isActive("blockquote"),
            code: e.isActive("codeBlock"),
            link: e.isActive("link"),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });

  const btn = (label: string, active: boolean | undefined, onClick: () => void, Icon: React.ComponentType<{ className?: string }>, disabled = false) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled || !editor}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40", active && "bg-muted text-foreground")}
    >
      <Icon className="size-4" />
    </button>
  );

  return (
    <div className={cn("rounded-lg border bg-background focus-within:ring-3 focus-within:ring-ring/50", className)}>
      <div className="flex flex-wrap gap-0.5 border-b p-1" role="toolbar" aria-label={t("editor.toolbar", "Formatting")}>
        {btn(t("editor.bold", "Bold"), state?.bold, () => editor?.chain().focus().toggleBold().run(), Bold)}
        {btn(t("editor.italic", "Italic"), state?.italic, () => editor?.chain().focus().toggleItalic().run(), Italic)}
        {btn(t("editor.heading", "Heading"), state?.h2, () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), Heading2)}
        {btn(t("editor.bulletList", "Bulleted list"), state?.bullet, () => editor?.chain().focus().toggleBulletList().run(), List)}
        {btn(t("editor.orderedList", "Numbered list"), state?.ordered, () => editor?.chain().focus().toggleOrderedList().run(), ListOrdered)}
        {btn(t("editor.quote", "Quote"), state?.quote, () => editor?.chain().focus().toggleBlockquote().run(), Quote)}
        {btn(t("editor.code", "Code block"), state?.code, () => editor?.chain().focus().toggleCodeBlock().run(), Code)}
        {btn(
          t("editor.link", "Link"),
          state?.link,
          () => {
            if (!editor) return;
            if (editor.isActive("link")) {
              editor.chain().focus().unsetLink().run();
              return;
            }
            const url = window.prompt(t("editor.linkPrompt", "Link URL (https://…)"));
            if (url && /^(https?:\/\/|mailto:)/i.test(url)) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
          },
          Link2,
        )}
        <span className="mx-1 w-px bg-border" aria-hidden />
        {btn(t("editor.undo", "Undo"), false, () => editor?.chain().focus().undo().run(), Undo2, !state?.canUndo)}
        {btn(t("editor.redo", "Redo"), false, () => editor?.chain().focus().redo().run(), Redo2, !state?.canRedo)}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
