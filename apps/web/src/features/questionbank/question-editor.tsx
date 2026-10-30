"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorAlert, QueryState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { SwitchField, selectClass } from "../assignment/form-utils";
import { TYPE_LABEL, type QuestionType } from "../quiz/api";
import {
  bankKeys,
  emptyQuestion,
  newId,
  useQuestion,
  wildcardsIn,
  type CalculatedData,
  type EssayData,
  type GapselectData,
  type MatchingData,
  type MultichoiceData,
  type NumericalData,
  type QuestionDetail,
  type QuestionInput,
  type ShortanswerData,
  type TruefalseData,
} from "./api";

const FRACTIONS = [
  1, 0.9, 0.8333333, 0.8, 0.75, 0.7, 0.6666667, 0.6, 0.5, 0.4, 0.3333333, 0.3, 0.25, 0.2, 0.1666667, 0.1428571, 0.125, 0.1111111, 0.1, 0.05, 0,
];
const pct = (f: number) => `${Math.round(f * 100000) / 1000}%`;

function FractionSelect({ id, value, onChange, allowNegative }: { id: string; value: number; onChange: (f: number) => void; allowNegative?: boolean }) {
  const options = allowNegative
    ? [
        ...FRACTIONS,
        ...FRACTIONS.slice(0, -1)
          .reverse()
          .map((f) => -f),
      ]
    : FRACTIONS;
  const known = options.some((o) => Math.abs(o - value) < 1e-6);
  return (
    <select id={id} className={selectClass} value={String(value)} onChange={(e) => onChange(Number(e.target.value))} aria-label="Grade">
      {!known && <option value={String(value)}>{pct(value)}</option>}
      {options.map((f) => (
        <option key={f} value={String(f)}>
          {f === 0 ? "None" : pct(f)}
        </option>
      ))}
    </select>
  );
}

type EditorProps = {
  courseId: string;
  categoryId: string;
  questionId: string | null;
  initialType?: QuestionType;
  onClose: () => void;
};

/** Create (questionId = null) or edit (saves a new version) a question. */
export function QuestionEditorDialog(props: EditorProps) {
  const existing = useQuestion(props.questionId, props.courseId);
  if (props.questionId && !existing.data) {
    return (
      <Dialog open onOpenChange={(o) => !o && props.onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit question</DialogTitle>
          </DialogHeader>
          <QueryState query={existing}>{null}</QueryState>
        </DialogContent>
      </Dialog>
    );
  }
  const v = existing.data?.current;
  const initial = v
    ? ({
        type: v.type,
        name: v.name,
        text: v.text,
        defaultMark: v.defaultMark,
        generalFeedback: v.generalFeedback,
        data: v.data,
      } as QuestionInput)
    : emptyQuestion(props.initialType ?? "multichoice");
  return <EditorDialog {...props} initial={initial} />;
}

function EditorDialog({ categoryId, questionId, onClose, initial }: EditorProps & { initial: QuestionInput }) {
  const [q, setQ] = useState<QuestionInput>(initial);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (input: QuestionInput) =>
      questionId
        ? api<QuestionDetail>(`/question-bank/questions/${questionId}`, {
            method: "PUT",
            body: input,
          })
        : api<QuestionDetail>("/question-bank/questions", {
            body: { ...input, categoryId },
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankKeys.all });
      toast.success(questionId ? "Saved as a new version" : "Question created");
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{questionId ? "Edit question" : `New ${TYPE_LABEL[q.type].toLowerCase()} question`}</DialogTitle>
        </DialogHeader>
        <form
          id="question-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(normalise(q));
          }}
        >
          {!questionId && (
            <div className="space-y-1.5">
              <Label htmlFor="q-type">Type</Label>
              <select
                id="q-type"
                className={selectClass}
                value={q.type}
                onChange={(e) =>
                  setQ({
                    ...emptyQuestion(e.target.value as QuestionType),
                    name: q.name,
                    text: q.text,
                  })
                }
              >
                {Object.entries(TYPE_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <div className="space-y-1.5">
              <Label htmlFor="q-name">Name</Label>
              <Input id="q-name" required maxLength={255} value={q.name} onChange={(e) => setQ({ ...q, name: e.target.value })} />
              <p className="text-xs text-muted-foreground">Only teachers see the name.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-mark">Default mark</Label>
              <Input
                id="q-mark"
                type="number"
                min={0}
                step="any"
                required
                value={q.defaultMark}
                onChange={(e) => setQ({ ...q, defaultMark: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q-text">Question text</Label>
            <Textarea id="q-text" required rows={4} value={q.text} onChange={(e) => setQ({ ...q, text: e.target.value })} />
            <p className="text-xs text-muted-foreground">Basic HTML is allowed.</p>
          </div>

          {q.type === "gapselect" && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Write each gap as [[n]], where n is the number of the correct choice below, e.g. “The [[1]] sat on the [[2]].”
            </p>
          )}
          {q.type === "calculated" && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Use wildcards like {"{x}"} for values drawn per attempt, and {"{={x}*2}"} to show a computed value.
            </p>
          )}

          <TypeEditor q={q} onChange={setQ} />

          <div className="space-y-1.5">
            <Label htmlFor="q-gf">General feedback</Label>
            <Textarea id="q-gf" rows={2} value={q.generalFeedback ?? ""} onChange={(e) => setQ({ ...q, generalFeedback: e.target.value || null })} />
            <p className="text-xs text-muted-foreground">Shown after the attempt when feedback is enabled in the quiz.</p>
          </div>
          {save.isError && <ErrorAlert error={save.error} title="The question could not be saved" />}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="question-form" disabled={save.isPending}>
            {save.isPending ? "Saving…" : questionId ? "Save new version" : "Create question"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Trims empty rows before sending (the API validates the rest). */
function normalise(q: QuestionInput): QuestionInput {
  switch (q.type) {
    case "multichoice":
      return {
        ...q,
        data: {
          ...q.data,
          options: q.data.options.filter((o) => o.text.trim()),
        },
      };
    case "shortanswer":
      return {
        ...q,
        data: {
          ...q.data,
          answers: q.data.answers.filter((a) => a.text.trim()),
        },
      };
    case "matching":
      return {
        ...q,
        data: { pairs: q.data.pairs.filter((p) => p.answer.trim()) },
      };
    case "calculated": {
      // Exactly the wildcards the text and formulas use; ones never edited get the default range shown in the editor.
      const names = wildcardsIn(q.text, ...q.data.answers.map((a) => a.formula));
      const variables = names.map((name) => q.data.variables.find((v) => v.name === name) ?? defaultWildcard(name));
      return { ...q, data: { ...q.data, answers: q.data.answers.filter((a) => a.formula.trim()), variables } };
    }
    case "essay": {
      const d: EssayData = {};
      if (q.data.responseTemplate) d.responseTemplate = q.data.responseTemplate;
      if (q.data.minWords) d.minWords = q.data.minWords;
      return { ...q, data: d };
    }
    default:
      return q;
  }
}

function TypeEditor({ q, onChange }: { q: QuestionInput; onChange: (q: QuestionInput) => void }) {
  switch (q.type) {
    case "multichoice":
      return <MultichoiceEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "truefalse":
      return <TruefalseEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "shortanswer":
      return <ShortanswerEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "numerical":
      return <NumericalEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "essay":
      return <EssayEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "matching":
      return <MatchingEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "calculated":
      return <CalculatedEditor text={q.text} data={q.data} onChange={(data) => onChange({ ...q, data })} />;
    case "gapselect":
      return <GapselectEditor data={q.data} onChange={(data) => onChange({ ...q, data })} />;
  }
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

function MultichoiceEditor({ data, onChange }: { data: MultichoiceData; onChange: (d: MultichoiceData) => void }) {
  const setOpt = (i: number, patch: Partial<MultichoiceData["options"][number]>) =>
    onChange({
      ...data,
      options: data.options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    });
  return (
    <Section
      title="Choices"
      hint={data.single ? "One choice must be worth 100%." : "The positive grades must add up to 100%. Wrong choices can carry a penalty."}
    >
      <SwitchField label="Multiple answers allowed" checked={!data.single} onChange={(c) => onChange({ ...data, single: !c })} />
      {data.options.map((o, i) => (
        <div key={o.id} className="grid gap-2 rounded-lg bg-muted/30 p-2 sm:grid-cols-[1fr_130px_auto]">
          <div className="space-y-1">
            <Label htmlFor={`opt-${o.id}`} className="text-xs">
              Choice {i + 1}
            </Label>
            <Input id={`opt-${o.id}`} value={o.text} onChange={(e) => setOpt(i, { text: e.target.value })} />
            <Input
              aria-label={`Feedback for choice ${i + 1}`}
              placeholder="Feedback (optional)"
              value={o.feedback}
              onChange={(e) => setOpt(i, { feedback: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`frac-${o.id}`} className="text-xs">
              Grade
            </Label>
            <FractionSelect id={`frac-${o.id}`} value={o.fraction} allowNegative onChange={(f) => setOpt(i, { fraction: f })} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="self-center"
            aria-label={`Remove choice ${i + 1}`}
            disabled={data.options.length <= 2}
            onClick={() =>
              onChange({
                ...data,
                options: data.options.filter((_, j) => j !== i),
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={data.options.length >= 26}
        onClick={() =>
          onChange({
            ...data,
            options: [...data.options, { id: newId(), text: "", fraction: 0, feedback: "" }],
          })
        }
      >
        <Plus /> Add choice
      </Button>
    </Section>
  );
}

function TruefalseEditor({ data, onChange }: { data: TruefalseData; onChange: (d: TruefalseData) => void }) {
  return (
    <Section title="Correct answer">
      <div className="flex gap-4 text-sm">
        {[true, false].map((b) => (
          <label key={String(b)} className="flex items-center gap-2">
            <input type="radio" name="tf-correct" className="accent-primary" checked={data.correct === b} onChange={() => onChange({ correct: b })} />
            {b ? "True" : "False"}
          </label>
        ))}
      </div>
    </Section>
  );
}

function ShortanswerEditor({ data, onChange }: { data: ShortanswerData; onChange: (d: ShortanswerData) => void }) {
  const setAns = (i: number, patch: Partial<ShortanswerData["answers"][number]>) =>
    onChange({
      ...data,
      answers: data.answers.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    });
  return (
    <Section title="Accepted answers" hint="Use * as a wildcard (e.g. “colo*r”). One answer must be worth 100%.">
      <SwitchField label="Case sensitive" checked={data.caseSensitive} onChange={(c) => onChange({ ...data, caseSensitive: c })} />
      {data.answers.map((a, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_130px_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`sa-${i}`} className="text-xs">
              Answer {i + 1}
            </Label>
            <Input id={`sa-${i}`} value={a.text} onChange={(e) => setAns(i, { text: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`saf-${i}`} className="text-xs">
              Grade
            </Label>
            <FractionSelect id={`saf-${i}`} value={a.fraction} onChange={(f) => setAns(i, { fraction: f })} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove answer ${i + 1}`}
            disabled={data.answers.length <= 1}
            onClick={() =>
              onChange({
                ...data,
                answers: data.answers.filter((_, j) => j !== i),
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange({
            ...data,
            answers: [...data.answers, { text: "", fraction: 0 }],
          })
        }
      >
        <Plus /> Add answer
      </Button>
    </Section>
  );
}

function NumericalEditor({ data, onChange }: { data: NumericalData; onChange: (d: NumericalData) => void }) {
  const setAns = (i: number, patch: Partial<NumericalData["answers"][number]>) =>
    onChange({
      answers: data.answers.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    });
  return (
    <Section title="Answers" hint="A response is accepted when it is within ± tolerance of the value. One answer must be worth 100%.">
      {data.answers.map((a, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_130px_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`nv-${i}`} className="text-xs">
              Value
            </Label>
            <Input id={`nv-${i}`} type="number" step="any" value={a.value} onChange={(e) => setAns(i, { value: Number(e.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`nt-${i}`} className="text-xs">
              Tolerance ±
            </Label>
            <Input
              id={`nt-${i}`}
              type="number"
              step="any"
              min={0}
              value={a.tolerance}
              onChange={(e) => setAns(i, { tolerance: Math.abs(Number(e.target.value)) })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`nf-${i}`} className="text-xs">
              Grade
            </Label>
            <FractionSelect id={`nf-${i}`} value={a.fraction} onChange={(f) => setAns(i, { fraction: f })} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove answer ${i + 1}`}
            disabled={data.answers.length <= 1}
            onClick={() => onChange({ answers: data.answers.filter((_, j) => j !== i) })}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange({
            answers: [...data.answers, { value: 0, tolerance: 0, fraction: 0 }],
          })
        }
      >
        <Plus /> Add answer
      </Button>
    </Section>
  );
}

function EssayEditor({ data, onChange }: { data: EssayData; onChange: (d: EssayData) => void }) {
  return (
    <Section title="Essay options" hint="Essays are graded manually by a teacher.">
      <div className="space-y-1.5">
        <Label htmlFor="essay-template">Response template</Label>
        <Textarea
          id="essay-template"
          rows={3}
          value={data.responseTemplate ?? ""}
          onChange={(e) => onChange({ ...data, responseTemplate: e.target.value || undefined })}
        />
      </div>
      <div className="max-w-40 space-y-1.5">
        <Label htmlFor="essay-min">Minimum words</Label>
        <Input
          id="essay-min"
          type="number"
          min={0}
          step={1}
          value={data.minWords ?? ""}
          onChange={(e) =>
            onChange({
              ...data,
              minWords: e.target.value ? Math.max(0, Math.round(Number(e.target.value))) : undefined,
            })
          }
        />
      </div>
    </Section>
  );
}

function MatchingEditor({ data, onChange }: { data: MatchingData; onChange: (d: MatchingData) => void }) {
  const setPair = (i: number, patch: Partial<MatchingData["pairs"][number]>) =>
    onChange({
      pairs: data.pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    });
  return (
    <Section title="Pairs" hint="At least two pairs need a question. A pair with an empty question adds an extra (wrong) answer.">
      {data.pairs.map((p, i) => (
        <div key={p.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`mq-${p.id}`} className="text-xs">
              Question {i + 1}
            </Label>
            <Input id={`mq-${p.id}`} value={p.question} onChange={(e) => setPair(i, { question: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ma-${p.id}`} className="text-xs">
              Matching answer
            </Label>
            <Input id={`ma-${p.id}`} value={p.answer} onChange={(e) => setPair(i, { answer: e.target.value })} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove pair ${i + 1}`}
            disabled={data.pairs.length <= 2}
            onClick={() => onChange({ pairs: data.pairs.filter((_, j) => j !== i) })}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange({
            pairs: [...data.pairs, { id: newId(), question: "", answer: "" }],
          })
        }
      >
        <Plus /> Add pair
      </Button>
    </Section>
  );
}

const defaultWildcard = (name: string) => ({ name, min: 1, max: 10, decimals: 1 });

const TOLERANCE_TYPES = [
  { value: "relative", label: "Relative (± fraction of the answer)" },
  { value: "nominal", label: "Nominal (± absolute)" },
  { value: "geometric", label: "Geometric" },
] as const;

function CalculatedEditor({ text, data, onChange }: { text: string; data: CalculatedData; onChange: (d: CalculatedData) => void }) {
  const setAns = (i: number, patch: Partial<CalculatedData["answers"][number]>) =>
    onChange({
      ...data,
      answers: data.answers.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    });
  // Every wildcard used in the text or a formula gets a range; new ones start at 1–10.
  const names = wildcardsIn(text, ...data.answers.map((a) => a.formula));
  const variables = names.map((name) => data.variables.find((v) => v.name === name) ?? defaultWildcard(name));
  const setVar = (name: string, patch: Partial<CalculatedData["variables"][number]>) =>
    onChange({
      ...data,
      variables: variables.map((v) => (v.name === name ? { ...v, ...patch } : v)),
    });
  return (
    <>
      <Section
        title="Answer formulas"
        hint="Formulas use the wildcards, e.g. {w} * {h}, and functions like sqrt(), round(x, 2) or pi(). One formula must be worth 100%."
      >
        {data.answers.map((a, i) => (
          <div key={i} className="grid gap-2 rounded-lg bg-muted/30 p-2 sm:grid-cols-[1fr_130px_auto]">
            <div className="space-y-1">
              <Label htmlFor={`cf-${i}`} className="text-xs">
                Formula {i + 1}
              </Label>
              <Input id={`cf-${i}`} className="font-mono" value={a.formula} onChange={(e) => setAns(i, { formula: e.target.value })} />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_2fr_1fr]">
                <div className="space-y-1">
                  <Label htmlFor={`ct-${i}`} className="text-xs">
                    Tolerance
                  </Label>
                  <Input
                    id={`ct-${i}`}
                    type="number"
                    step="any"
                    min={0}
                    value={a.tolerance}
                    onChange={(e) => setAns(i, { tolerance: Math.abs(Number(e.target.value)) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`ctt-${i}`} className="text-xs">
                    Tolerance type
                  </Label>
                  <select
                    id={`ctt-${i}`}
                    className={selectClass}
                    value={a.toleranceType}
                    onChange={(e) =>
                      setAns(i, {
                        toleranceType: e.target.value as typeof a.toleranceType,
                      })
                    }
                  >
                    {TOLERANCE_TYPES.map((tt) => (
                      <option key={tt.value} value={tt.value}>
                        {tt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`cd-${i}`} className="text-xs">
                    Shown decimals
                  </Label>
                  <Input
                    id={`cd-${i}`}
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={a.answerDecimals}
                    onChange={(e) =>
                      setAns(i, {
                        answerDecimals: Math.max(0, Math.min(10, Math.round(Number(e.target.value)))),
                      })
                    }
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`cfr-${i}`} className="text-xs">
                Grade
              </Label>
              <FractionSelect id={`cfr-${i}`} value={a.fraction} onChange={(f) => setAns(i, { fraction: f })} />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="self-center"
              aria-label={`Remove formula ${i + 1}`}
              disabled={data.answers.length <= 1}
              onClick={() =>
                onChange({
                  ...data,
                  answers: data.answers.filter((_, j) => j !== i),
                })
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={data.answers.length >= 20}
          onClick={() =>
            onChange({
              ...data,
              answers: [
                ...data.answers,
                {
                  formula: "",
                  fraction: 0,
                  tolerance: 0.01,
                  toleranceType: "relative",
                  answerDecimals: 2,
                  answerFormat: "decimals",
                },
              ],
            })
          }
        >
          <Plus /> Add formula
        </Button>
      </Section>
      <Section title="Wildcards" hint="Each attempt draws a value between the minimum and maximum, rounded to the given decimals.">
        {!variables.length && <p className="text-sm text-muted-foreground">Use a wildcard such as {"{x}"} in the question text or a formula.</p>}
        {variables.map((v) => (
          <div key={v.name} className="grid grid-cols-[80px_1fr_1fr_1fr] items-end gap-2">
            <span className="pb-2 font-mono text-sm">{`{${v.name}}`}</span>
            <div className="space-y-1">
              <Label htmlFor={`vmin-${v.name}`} className="text-xs">
                Minimum
              </Label>
              <Input id={`vmin-${v.name}`} type="number" step="any" value={v.min} onChange={(e) => setVar(v.name, { min: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`vmax-${v.name}`} className="text-xs">
                Maximum
              </Label>
              <Input id={`vmax-${v.name}`} type="number" step="any" value={v.max} onChange={(e) => setVar(v.name, { max: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`vdec-${v.name}`} className="text-xs">
                Decimals
              </Label>
              <Input
                id={`vdec-${v.name}`}
                type="number"
                min={0}
                max={10}
                step={1}
                value={v.decimals}
                onChange={(e) =>
                  setVar(v.name, {
                    decimals: Math.max(0, Math.min(10, Math.round(Number(e.target.value)))),
                  })
                }
              />
            </div>
          </div>
        ))}
        {data.datasets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{data.datasets.length} fixed value set(s) (imported) are used instead of random values.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...data, variables, datasets: [] })}>
              Use random values instead
            </Button>
          </div>
        )}
      </Section>
    </>
  );
}

function GapselectEditor({ data, onChange }: { data: GapselectData; onChange: (d: GapselectData) => void }) {
  const setChoice = (i: number, patch: Partial<GapselectData["choices"][number]>) =>
    onChange({
      ...data,
      choices: data.choices.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  return (
    <Section title="Choices" hint="A gap offers every choice of the same group. Extra choices in a group act as distractors.">
      <SwitchField label="Shuffle the choices in each gap" checked={data.shuffle} onChange={(c) => onChange({ ...data, shuffle: c })} />
      {data.choices.map((c, i) => (
        <div key={i} className="grid grid-cols-[1fr_100px_auto] items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`gc-${i}`} className="text-xs">
              Choice [[{i + 1}]]
            </Label>
            <Input id={`gc-${i}`} value={c.text} onChange={(e) => setChoice(i, { text: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`gg-${i}`} className="text-xs">
              Group
            </Label>
            <select id={`gg-${i}`} className={selectClass} value={c.group} onChange={(e) => setChoice(i, { group: Number(e.target.value) })}>
              {Array.from({ length: 8 }, (_, k) => k + 1).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove choice ${i + 1}`}
            disabled={data.choices.length <= 2 || i < data.choices.length - 1}
            title={i < data.choices.length - 1 ? "Only the last choice can be removed (gaps refer to choice numbers)" : undefined}
            onClick={() => onChange({ ...data, choices: data.choices.slice(0, -1) })}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={data.choices.length >= 100}
        onClick={() =>
          onChange({
            ...data,
            choices: [...data.choices, { text: "", group: 1 }],
          })
        }
      >
        <Plus /> Add choice
      </Button>
    </Section>
  );
}
