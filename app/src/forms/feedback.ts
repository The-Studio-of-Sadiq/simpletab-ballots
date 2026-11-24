import type { RoundBundleRow } from "@simpletab/core/bundle";
import {
  integerScaleChoices,
  numericBoundsText,
  validateFeedbackAnswers,
} from "@simpletab/core/lib/feedback/questions";
import {
  defaultFeedbackScore,
  feedbackScoreStep,
  validateFeedbackScore,
} from "@simpletab/core/lib/scoring/validator";
import type { FeedbackAnswer, FeedbackQuestion, TournamentPreferences } from "@/types";
import { focusFirstError, setFieldValidity, type LiveAnnouncer } from "../a11y";
import type { TranslateFn } from "../i18n";
import type {
  BallotCollectionMode,
  FeedbackFormDefinition,
  FeedbackTarget,
} from "../manifest";

export interface FeedbackDraftData {
  targetId?: string;
  score?: string;
  answers?: Record<string, FeedbackAnswer>;
}

export interface FeedbackFormHandle {
  element: HTMLElement;
  setLocked(locked: boolean): void;
}

export interface RenderFeedbackFormOptions {
  def: FeedbackFormDefinition;
  preferences?: Partial<TournamentPreferences>;
  row: RoundBundleRow;
  mode: BallotCollectionMode;
  initialDraft?: FeedbackDraftData | null;
  locked?: boolean;
  t: TranslateFn;
  announcer: LiveAnnouncer;
  onDraftChange?: (draft: FeedbackDraftData) => void;
  onSubmitOnline: (payload: Record<string, unknown>) => Promise<void>;
  onShowQr: (payload: Record<string, unknown>) => Promise<void>;
}

export function renderFeedbackForm(options: RenderFeedbackFormOptions): FeedbackFormHandle {
  const {
    def,
    preferences,
    row,
    mode,
    initialDraft,
    t,
    announcer,
    onDraftChange,
    onSubmitOnline,
    onShowQr,
  } = options;

  const mergedPrefs: Partial<TournamentPreferences> = {
    ...preferences,
    ...(def.minScore !== undefined ? { feedbackMinScore: def.minScore } : {}),
    ...(def.maxScore !== undefined ? { feedbackMaxScore: def.maxScore } : {}),
    ...(def.scoreStep !== undefined ? { feedbackScoreStep: def.scoreStep } : {}),
  };

  const targets: FeedbackTarget[] =
    def.targets ??
    (row.panel ?? []).map((member, index) => ({
      id: `panel-${index}`,
      name: member.name,
      role: member.role,
    }));

  const section = document.createElement("section");
  section.className = "card form-card";
  const headingId = `feedback-heading-${def.id}`;
  section.setAttribute("aria-labelledby", headingId);

  const heading = document.createElement("h2");
  heading.id = headingId;
  heading.textContent = def.title ?? t("feedback.heading");
  section.append(heading);

  const introText = def.introduction ?? preferences?.feedbackIntroduction;
  if (introText) {
    const intro = document.createElement("p");
    intro.className = "hint";
    intro.textContent = introText;
    section.append(intro);
  }

  const form = document.createElement("form");
  form.noValidate = true;
  form.setAttribute("aria-labelledby", headingId);

  const errorSummary = document.createElement("div");
  errorSummary.className = "error-summary";
  errorSummary.setAttribute("role", "alert");
  errorSummary.tabIndex = -1;
  errorSummary.hidden = true;
  form.append(errorSummary);

  let targetSelect: HTMLSelectElement | null = null;
  let targetError: HTMLElement | null = null;
  if (targets.length > 0) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `fb-target-${def.id}`;
    label.textContent = t("feedback.targetLabel");
    targetSelect = document.createElement("select");
    targetSelect.id = `fb-target-${def.id}`;
    targetSelect.name = "targetId";
    targetSelect.required = true;
    targetSelect.setAttribute("aria-invalid", "false");

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = t("feedback.chooseTarget");
    targetSelect.append(blank);
    for (const target of targets) {
      const opt = document.createElement("option");
      opt.value = target.id;
      opt.textContent = target.role ? `${target.name} (${target.role})` : target.name;
      targetSelect.append(opt);
    }
    if (initialDraft?.targetId) {
      targetSelect.value = initialDraft.targetId;
    } else if (targets.length === 1) {
      targetSelect.value = targets[0].id;
    }

    targetError = document.createElement("p");
    targetError.id = `fb-target-err-${def.id}`;
    targetError.className = "field-error";
    targetError.hidden = true;

    const selRef = targetSelect;
    const errRef = targetError;
    selRef.addEventListener("change", () => {
      setFieldValidity(selRef, errRef, selRef.value ? "" : t("feedback.chooseTarget"));
      emitDraft();
    });

    field.append(label, targetSelect, targetError);
    form.append(field);
  }

  // Overall feedback score.
  const minScore = mergedPrefs.feedbackMinScore ?? 1;
  const maxScore = mergedPrefs.feedbackMaxScore ?? 10;
  const stepScore = feedbackScoreStep(mergedPrefs);

  const scoreField = document.createElement("div");
  scoreField.className = "field";
  const scoreLabel = document.createElement("label");
  scoreLabel.htmlFor = `fb-score-${def.id}`;
  scoreLabel.textContent = t("feedback.scoreLabel", {
    min: minScore,
    max: maxScore,
    step: stepScore,
  });

  const scoreInput = document.createElement("input");
  scoreInput.type = "text";
  scoreInput.inputMode = "decimal";
  scoreInput.id = `fb-score-${def.id}`;
  scoreInput.name = "score";
  scoreInput.required = true;
  scoreInput.setAttribute("aria-invalid", "false");
  scoreInput.value =
    initialDraft?.score ?? String(defaultFeedbackScore(mergedPrefs));

  const scoreError = document.createElement("p");
  scoreError.id = `fb-score-err-${def.id}`;
  scoreError.className = "field-error";
  scoreError.hidden = true;

  scoreInput.addEventListener("blur", () => {
    const raw = scoreInput.value.trim();
    if (!raw) return;
    const check = validateFeedbackScore(Number(raw), mergedPrefs);
    setFieldValidity(scoreInput, scoreError, check.valid ? "" : check.error ?? "Invalid score.");
  });
  scoreInput.addEventListener("input", () => {
    setFieldValidity(scoreInput, scoreError, "");
    emitDraft();
  });

  scoreField.append(scoreLabel, scoreInput, scoreError);
  form.append(scoreField);

  // Dynamic feedback questions covering all 10 FeedbackQuestionTypes.
  const readers = new Map<string, () => FeedbackAnswer>();

  function questionLabelText(q: FeedbackQuestion): string {
    return q.required ? `${q.label} ${t("feedback.requiredMark")}` : q.label;
  }

  for (const q of def.questions) {
    const initialAnswer = initialDraft?.answers?.[q.id];
    const qId = `fb-q-${def.id}-${q.id}`;

    if (q.type === "yes_no") {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "field";
      const legend = document.createElement("legend");
      legend.textContent = questionLabelText(q);
      fieldset.append(legend);

      const yesRow = document.createElement("div");
      yesRow.className = "radio-row";
      const yesRadio = document.createElement("input");
      yesRadio.type = "radio";
      yesRadio.id = `${qId}-yes`;
      yesRadio.name = qId;
      yesRadio.value = "true";
      yesRadio.checked = initialAnswer === true;
      const yesLbl = document.createElement("label");
      yesLbl.htmlFor = yesRadio.id;
      yesLbl.textContent = t("feedback.yes");
      yesRow.append(yesRadio, yesLbl);

      const noRow = document.createElement("div");
      noRow.className = "radio-row";
      const noRadio = document.createElement("input");
      noRadio.type = "radio";
      noRadio.id = `${qId}-no`;
      noRadio.name = qId;
      noRadio.value = "false";
      noRadio.checked = initialAnswer === false;
      const noLbl = document.createElement("label");
      noLbl.htmlFor = noRadio.id;
      noLbl.textContent = t("feedback.no");
      noRow.append(noRadio, noLbl);

      yesRadio.addEventListener("change", emitDraft);
      noRadio.addEventListener("change", emitDraft);
      fieldset.append(yesRow, noRow);
      form.append(fieldset);

      readers.set(q.id, () => {
        if (yesRadio.checked) return true;
        if (noRadio.checked) return false;
        return null;
      });
      continue;
    }

    if (q.type === "checkbox") {
      const rowEl = document.createElement("div");
      rowEl.className = "checkbox-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = qId;
      cb.name = qId;
      cb.checked = initialAnswer === true;
      cb.addEventListener("change", emitDraft);
      const lbl = document.createElement("label");
      lbl.htmlFor = qId;
      lbl.textContent = questionLabelText(q);
      rowEl.append(cb, lbl);
      form.append(rowEl);
      readers.set(q.id, () => cb.checked);
      continue;
    }

    if (q.type === "integer_scale") {
      const choices = integerScaleChoices(q);
      if (choices.length > 0) {
        const fieldset = document.createElement("fieldset");
        fieldset.className = "field";
        const legend = document.createElement("legend");
        legend.textContent = questionLabelText(q);
        fieldset.append(legend);
        const radios: HTMLInputElement[] = [];
        for (const val of choices) {
          const rRow = document.createElement("div");
          rRow.className = "radio-row";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.id = `${qId}-${val}`;
          radio.name = qId;
          radio.value = String(val);
          radio.checked = initialAnswer === val;
          radio.addEventListener("change", emitDraft);
          const lbl = document.createElement("label");
          lbl.htmlFor = radio.id;
          lbl.textContent = String(val);
          rRow.append(radio, lbl);
          fieldset.append(rRow);
          radios.push(radio);
        }
        form.append(fieldset);
        readers.set(q.id, () => {
          const checked = radios.find((r) => r.checked);
          return checked ? Number(checked.value) : null;
        });
        continue;
      }
    }

    if (q.type === "select_one") {
      const opts = q.options ?? [];
      if (opts.length <= 5) {
        const fieldset = document.createElement("fieldset");
        fieldset.className = "field";
        const legend = document.createElement("legend");
        legend.textContent = questionLabelText(q);
        fieldset.append(legend);
        const radios: HTMLInputElement[] = [];
        for (let i = 0; i < opts.length; i++) {
          const optVal = opts[i];
          const rRow = document.createElement("div");
          rRow.className = "radio-row";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.id = `${qId}-${i}`;
          radio.name = qId;
          radio.value = optVal;
          radio.checked = initialAnswer === optVal;
          radio.addEventListener("change", emitDraft);
          const lbl = document.createElement("label");
          lbl.htmlFor = radio.id;
          lbl.textContent = optVal;
          rRow.append(radio, lbl);
          fieldset.append(rRow);
          radios.push(radio);
        }
        form.append(fieldset);
        readers.set(q.id, () => {
          const checked = radios.find((r) => r.checked);
          return checked ? checked.value : null;
        });
      } else {
        const field = document.createElement("div");
        field.className = "field";
        const lbl = document.createElement("label");
        lbl.htmlFor = qId;
        lbl.textContent = questionLabelText(q);
        const sel = document.createElement("select");
        sel.id = qId;
        sel.name = qId;
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = t("feedback.chooseOption");
        sel.append(blank);
        for (const optVal of opts) {
          const opt = document.createElement("option");
          opt.value = optVal;
          opt.textContent = optVal;
          sel.append(opt);
        }
        if (typeof initialAnswer === "string") {
          sel.value = initialAnswer;
        }
        sel.addEventListener("change", emitDraft);
        field.append(lbl, sel);
        form.append(field);
        readers.set(q.id, () => (sel.value ? sel.value : null));
      }
      continue;
    }

    if (q.type === "select_many") {
      const opts = q.options ?? [];
      const selectedSet = new Set(Array.isArray(initialAnswer) ? initialAnswer : []);
      const fieldset = document.createElement("fieldset");
      fieldset.className = "field";
      const legend = document.createElement("legend");
      legend.textContent = questionLabelText(q);
      fieldset.append(legend);
      const boxes: HTMLInputElement[] = [];
      for (let i = 0; i < opts.length; i++) {
        const optVal = opts[i];
        const cRow = document.createElement("div");
        cRow.className = "checkbox-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = `${qId}-${i}`;
        cb.name = qId;
        cb.value = optVal;
        cb.checked = selectedSet.has(optVal);
        cb.addEventListener("change", emitDraft);
        const lbl = document.createElement("label");
        lbl.htmlFor = cb.id;
        lbl.textContent = optVal;
        cRow.append(cb, lbl);
        fieldset.append(cRow);
        boxes.push(cb);
      }
      form.append(fieldset);
      readers.set(q.id, () => boxes.filter((b) => b.checked).map((b) => b.value));
      continue;
    }

    if (q.type === "textarea") {
      const field = document.createElement("div");
      field.className = "field";
      const lbl = document.createElement("label");
      lbl.htmlFor = qId;
      lbl.textContent = questionLabelText(q);
      const ta = document.createElement("textarea");
      ta.id = qId;
      ta.name = qId;
      ta.rows = 3;
      ta.value = typeof initialAnswer === "string" ? initialAnswer : "";
      ta.addEventListener("input", emitDraft);
      field.append(lbl, ta);
      form.append(field);
      readers.set(q.id, () => ta.value);
      continue;
    }

    // "text", "integer", "float", "scale"
    const field = document.createElement("div");
    field.className = "field";
    const lbl = document.createElement("label");
    lbl.htmlFor = qId;
    const bounds =
      q.type === "integer" || q.type === "float" || q.type === "scale"
        ? numericBoundsText(q)
        : "";
    lbl.textContent = bounds
      ? `${questionLabelText(q)} (${bounds})`
      : questionLabelText(q);

    const input = document.createElement("input");
    input.id = qId;
    input.name = qId;
    input.type = "text";
    if (q.type === "integer") {
      input.inputMode = "numeric";
    } else if (q.type === "float" || q.type === "scale") {
      input.inputMode = "decimal";
    }
    if (typeof initialAnswer === "string" || typeof initialAnswer === "number") {
      input.value = String(initialAnswer);
    }
    input.addEventListener("input", emitDraft);
    field.append(lbl, input);
    form.append(field);

    if (q.type === "text") {
      readers.set(q.id, () => input.value);
    } else {
      readers.set(q.id, () => {
        const raw = input.value.trim();
        if (raw.length === 0) return null;
        return Number(raw);
      });
    }
  }

  function collectAnswers(): Record<string, FeedbackAnswer> {
    const answers: Record<string, FeedbackAnswer> = {};
    for (const [qId, read] of readers.entries()) {
      answers[qId] = read();
    }
    return answers;
  }

  function emitDraft(): void {
    onDraftChange?.({
      targetId: targetSelect?.value,
      score: scoreInput.value,
      answers: collectAnswers(),
    });
  }

  function validateAndBuildPayload(): Record<string, unknown> | null {
    const errors: string[] = [];

    if (targetSelect && targetError) {
      if (!targetSelect.value) {
        const msg = t("feedback.chooseTarget");
        setFieldValidity(targetSelect, targetError, msg);
        errors.push(msg);
      } else {
        setFieldValidity(targetSelect, targetError, "");
      }
    }

    const rawScore = scoreInput.value.trim();
    const numericScore = rawScore.length === 0 ? Number.NaN : Number(rawScore);
    const scoreCheck = validateFeedbackScore(numericScore, mergedPrefs);
    if (!scoreCheck.valid) {
      const msg = scoreCheck.error ?? "Invalid score.";
      setFieldValidity(scoreInput, scoreError, msg);
      errors.push(msg);
    } else {
      setFieldValidity(scoreInput, scoreError, "");
    }

    const answers = collectAnswers();
    const answerErr = validateFeedbackAnswers(def.questions, answers);
    if (answerErr) {
      errors.push(answerErr);
    }

    if (errors.length > 0) {
      errorSummary.hidden = false;
      const title = document.createElement("p");
      title.textContent = t("form.validationSummary", { count: errors.length });
      const list = document.createElement("ul");
      for (const msg of errors) {
        const li = document.createElement("li");
        li.textContent = msg;
        list.append(li);
      }
      errorSummary.replaceChildren(title, list);
      announcer.announceAssertive(errors[0]);
      focusFirstError(form);
      return null;
    }

    errorSummary.hidden = true;
    errorSummary.replaceChildren();
    return {
      formId: def.id,
      room: row.room,
      targetType: def.targetType,
      ...(targetSelect?.value ? { targetId: targetSelect.value } : {}),
      score: numericScore,
      answers,
    };
  }

  const actions = document.createElement("div");
  actions.className = "actions-row";
  const primaryBtn = document.createElement("button");
  primaryBtn.type = "submit";
  primaryBtn.className = "btn btn-primary";
  primaryBtn.textContent =
    mode === "qr_only" ? t("form.showFeedbackQr") : t("form.submitFeedback");
  actions.append(primaryBtn);

  let qrInsteadBtn: HTMLButtonElement | null = null;
  if (mode === "online_and_qr") {
    qrInsteadBtn = document.createElement("button");
    qrInsteadBtn.type = "button";
    qrInsteadBtn.className = "btn btn-secondary";
    qrInsteadBtn.textContent = t("form.showQrInstead");
    actions.append(qrInsteadBtn);
  }

  form.append(actions);
  section.append(form);

  let isLocked = options.locked === true;
  let isSubmitting = false;

  function syncDisabled(): void {
    const controls = form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >("input, select, textarea, button");
    for (const el of controls) {
      el.disabled = isLocked || isSubmitting;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isLocked || isSubmitting) return;
    const payload = validateAndBuildPayload();
    if (!payload) return;
    isSubmitting = true;
    primaryBtn.textContent = t("form.submitting");
    syncDisabled();
    try {
      if (mode === "qr_only") {
        await onShowQr(payload);
      } else {
        await onSubmitOnline(payload);
      }
    } finally {
      isSubmitting = false;
      primaryBtn.textContent =
        mode === "qr_only" ? t("form.showFeedbackQr") : t("form.submitFeedback");
      syncDisabled();
    }
  });

  qrInsteadBtn?.addEventListener("click", async () => {
    if (isLocked || isSubmitting) return;
    const payload = validateAndBuildPayload();
    if (!payload) return;
    await onShowQr(payload);
  });

  syncDisabled();

  return {
    element: section,
    setLocked(locked: boolean): void {
      isLocked = locked;
      syncDisabled();
    },
  };
}
