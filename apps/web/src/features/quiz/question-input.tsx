"use client";

import { CheckCircle2, CircleAlert, CircleDashed, XCircle } from "lucide-react";
import { HtmlContent } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { round, type AttemptQuestion, type Response } from "./api";

/** True when the learner has given some answer to the question. */
export function isAnswered(r: Response): boolean {
  if (!r) return false;
  if ("selected" in r) return r.selected.length > 0;
  if ("text" in r) return r.text.trim().length > 0;
  if ("matches" in r) return Object.values(r.matches).some(Boolean);
  if ("value" in r) return typeof r.value === "boolean" || String(r.value).trim().length > 0;
  return false;
}

const choiceClass =
  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/5";

/** Answer controls for one question. `readOnly` renders the learner's response without editing. */
export function QuestionInput({
  question,
  value,
  onChange,
  readOnly,
}: {
  question: AttemptQuestion;
  value: Response;
  onChange: (r: Response) => void;
  readOnly?: boolean;
}) {
  const t = useT();
  const v = question.view;
  const name = `q-${question.slotId}`;

  switch (v.type) {
    case "multichoice": {
      const selected = value && "selected" in value ? value.selected : [];
      return (
        <fieldset className="space-y-2" disabled={readOnly}>
          <legend className="mb-2 text-xs text-muted-foreground">{v.single ? t("quiz.selectOne", "Select one:") : t("quiz.selectMany", "Select one or more:")}</legend>
          {v.options.map((o, i) => (
            <label key={o.id} className={cn(choiceClass, readOnly && "cursor-default")}>
              <input
                type={v.single ? "radio" : "checkbox"}
                name={name}
                className="mt-0.5 accent-primary"
                checked={selected.includes(o.id)}
                onChange={(e) => {
                  if (v.single) onChange({ selected: [o.id] });
                  else onChange({ selected: e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id) });
                }}
              />
              <span>
                <span className="mr-1 text-muted-foreground">{String.fromCharCode(97 + i)}.</span>
                {o.text}
              </span>
            </label>
          ))}
          {v.single && selected.length > 0 && !readOnly && (
            <button
              type="button"
              className="rounded-sm text-xs text-muted-foreground underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => onChange(null)}
            >
              {t("quiz.clearChoice", "Clear my choice")}
            </button>
          )}
        </fieldset>
      );
    }
    case "truefalse": {
      const current = value && "value" in value && typeof value.value === "boolean" ? value.value : null;
      return (
        <fieldset className="grid gap-2 sm:grid-cols-2" disabled={readOnly}>
          <legend className="sr-only">{t("quiz.trueOrFalse", "True or false")}</legend>
          {[true, false].map((b) => (
            <label key={String(b)} className={choiceClass}>
              <input type="radio" name={name} className="mt-0.5 accent-primary" checked={current === b} onChange={() => onChange({ value: b })} />
              {b ? t("quiz.true", "True") : t("quiz.false", "False")}
            </label>
          ))}
        </fieldset>
      );
    }
    case "shortanswer":
    case "numerical": {
      const text = value && "text" in value ? value.text : value && "value" in value && typeof value.value === "string" ? value.value : "";
      return (
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor={name}>{t("quiz.answer", "Answer")}</Label>
          <Input
            id={name}
            readOnly={readOnly}
            inputMode={v.type === "numerical" ? "decimal" : undefined}
            autoComplete="off"
            value={text}
            onChange={(e) => onChange(v.type === "numerical" ? { value: e.target.value } : { text: e.target.value })}
          />
        </div>
      );
    }
    case "essay": {
      const text = value && "text" in value ? value.text : (v.responseTemplate ?? "");
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      // Essay responses are plain text in the API ({ text } response, not sanitized as HTML), so this stays a textarea.
      return (
        <div className="space-y-1.5">
          <Label htmlFor={name}>{t("quiz.yourAnswer", "Your answer")}</Label>
          <Textarea
            id={name}
            rows={10}
            readOnly={readOnly}
            aria-describedby={`${name}-words`}
            value={text}
            onChange={(e) => onChange({ text: e.target.value })}
          />
          <p id={`${name}-words`} className={cn("text-xs text-muted-foreground", v.minWords && words < v.minWords && "text-amber-600")}>
            {words === 1 ? t("quiz.words.one", "{count} word", { count: words }) : t("quiz.words.other", "{count} words", { count: words })}
            {v.minWords ? ` ${t("quiz.minWords", "(minimum {count})", { count: v.minWords })}` : ""}
          </p>
        </div>
      );
    }
    case "matching": {
      const matches = value && "matches" in value ? value.matches : {};
      return (
        <div className="space-y-3">
          {v.stems.map((s) => (
            <div key={s.id} className="grid gap-2 sm:grid-cols-[1fr_minmax(160px,240px)] sm:items-center">
              <label htmlFor={`${name}-${s.id}`} className="text-sm">
                {s.text}
              </label>
              <select
                id={`${name}-${s.id}`}
                disabled={readOnly}
                className="h-8 w-full rounded-lg border bg-background px-2 text-sm"
                value={matches[s.id] ?? ""}
                onChange={(e) => onChange({ matches: { ...matches, [s.id]: e.target.value } })}
              >
                <option value="">{t("quiz.choose", "Choose…")}</option>
                {v.choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      );
    }
  }
}

const STATE: Record<NonNullable<AttemptQuestion["state"]>, { key: string; label: string; icon: typeof CheckCircle2; className: string }> = {
  correct: { key: "quiz.state.correct", label: "Correct", icon: CheckCircle2, className: "text-green-600 dark:text-green-500" },
  partial: { key: "quiz.state.partial", label: "Partially correct", icon: CircleAlert, className: "text-amber-600 dark:text-amber-500" },
  incorrect: { key: "quiz.state.incorrect", label: "Incorrect", icon: XCircle, className: "text-destructive" },
  needs_grading: { key: "quiz.state.needsGrading", label: "Requires grading", icon: CircleDashed, className: "text-muted-foreground" },
};

/** One question card: header, text, input and (when released) review information. */
export function QuestionCard({
  question,
  value,
  onChange,
  readOnly,
  children,
}: {
  question: AttemptQuestion;
  value: Response;
  onChange: (r: Response) => void;
  readOnly?: boolean;
  children?: React.ReactNode;
}) {
  const t = useT();
  const st = question.state ? STATE[question.state] : null;
  return (
    <section className="space-y-4 rounded-xl border p-4 sm:p-5" aria-labelledby={`qh-${question.slotId}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`qh-${question.slotId}`} className="font-medium">
          {t("quiz.questionNumber", "Question {number}", { number: question.number })}
          {question.name && <span className="ml-2 text-sm font-normal text-muted-foreground">{question.name}</span>}
        </h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {st && (
            <span className={cn("inline-flex items-center gap-1 font-medium", st.className)}>
              <st.icon aria-hidden className="size-4" /> {t(st.key, st.label)}
            </span>
          )}
          <Badge variant="outline">
            {question.mark !== undefined && question.mark !== null ? `${round(question.mark)} / ` : ""}
            {question.maxMark === 1
              ? t("quiz.marks.one", "{count} mark", { count: round(question.maxMark) })
              : t("quiz.marks.other", "{count} marks", { count: round(question.maxMark) })}
          </Badge>
        </div>
      </header>
      <HtmlContent html={question.text} />
      <QuestionInput question={question} value={value} onChange={onChange} readOnly={readOnly} />
      {(question.feedback || question.generalFeedback || question.comment || question.rightAnswer) && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
          {question.feedback && <p className="whitespace-pre-line">{question.feedback}</p>}
          {question.generalFeedback && <HtmlContent html={question.generalFeedback} />}
          {question.rightAnswer && (
            <p>
              <span className="font-medium">{t("quiz.correctAnswer", "Correct answer:")}</span> {question.rightAnswer}
            </p>
          )}
          {question.comment && (
            <div>
              <span className="font-medium">{t("quiz.teacherComment", "Teacher comment:")}</span>
              <HtmlContent html={question.comment} />
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
