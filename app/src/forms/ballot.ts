import type { RoundBundleRow } from "@simpletab/core/bundle";
import {
  cleanScore,
  criteriaForSpeech,
  scoreCriteriaFor,
  validateCriterionScore,
  winnerDeclarationFor,
} from "@simpletab/core/lib/ballots/ballotRules";
import {
  applyScoreCriteria,
  consensusTeamScores,
  effectiveRanks,
  replySpeechesEnabled,
  rulesSides,
  selfSplitAllowed,
  substantiveSpeakerCount,
  teamSpeakerTotal,
  usesSpeakerScores,
  validateBallotEntry,
  type BallotEntry,
  type BallotRules,
  type BallotValidationContext,
  type SideRecord,
} from "@simpletab/core/lib/ballots/result";
import { isTwoTeamFormat } from "@simpletab/core/lib/debateSides";
import { validateReplyScore, validateSpeakerScore } from "@simpletab/core/lib/scoring/validator";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import type { DebateSide, Speaker, SpeakerScoreEntry } from "@/types";
import { focusFirstError, setFieldValidity, type LiveAnnouncer } from "../a11y";
import type { TranslateFn } from "../i18n";
import type {
  BallotCollectionMode,
  BallotFormDefinition,
  BallotSideRoster,
  FormsFile,
  MotionItem,
} from "../manifest";

export interface BallotDraftData {
  motionId?: string;
  substitution?: boolean;
  forfeitSide?: DebateSide;
  selfSplit?: boolean;
  ranks?: Partial<Record<DebateSide, number>>;
  winner?: DebateSide;
  speakerScores?: Partial<Record<DebateSide, SpeakerScoreEntry[]>>;
}

export interface BallotFormHandle {
  element: HTMLElement;
  setLocked(locked: boolean): void;
  setSubmitting(submitting: boolean): void;
  getPayload(): Record<string, unknown> | null;
}

export interface RenderBallotFormOptions {
  def: BallotFormDefinition;
  formsFile: FormsFile;
  row: RoundBundleRow;
  motions: readonly MotionItem[];
  mode: BallotCollectionMode;
  initialDraft?: BallotDraftData | null;
  locked?: boolean;
  t: TranslateFn;
  announcer: LiveAnnouncer;
  onDraftChange?: (draft: BallotDraftData) => void;
  onSubmitOnline: (payload: Record<string, unknown>) => Promise<void>;
  onShowQr: (payload: Record<string, unknown>) => Promise<void>;
}

interface SpeechControls {
  position: number;
  isReply: boolean;
  speakerSelect: HTMLSelectElement;
  scoreInput: HTMLInputElement | null;
  scoreError: HTMLElement | null;
  criterionInputs: Map<string, { input: HTMLInputElement; error: HTMLElement }>;
  ghostCheckbox: HTMLInputElement | null;
}

function resolveSideRosters(
  def: BallotFormDefinition,
  room: string,
  sides: DebateSide[],
): Partial<Record<DebateSide, BallotSideRoster>> {
  const fromRoom = def.rooms?.[room];
  const source = fromRoom ?? def.sides ?? {};
  const result: Partial<Record<DebateSide, BallotSideRoster>> = {};
  for (const side of sides) {
    if (source[side]) {
      result[side] = source[side];
    }
  }
  return result;
}

export function renderBallotForm(options: RenderBallotFormOptions): BallotFormHandle {
  const {
    def,
    formsFile,
    row,
    motions,
    mode,
    initialDraft,
    t,
    announcer,
    onDraftChange,
    onSubmitOnline,
    onShowQr,
  } = options;

  const preferences = formsFile.preferences;
  const effectiveRules: BallotRules = {
    format: formsFile.format,
    preferences: {
      ...preferences,
      ballotMode: "consensus",
      eliminationBallotMode: "consensus",
    },
    stage: formsFile.stage,
  };

  const sides = rulesSides(effectiveRules);
  const twoTeam = isTwoTeamFormat(effectiveRules.format);
  const scored = usesSpeakerScores(effectiveRules);
  const substantive = substantiveSpeakerCount(effectiveRules);
  const replies = replySpeechesEnabled(effectiveRules);
  const criteria = scoreCriteriaFor(preferences);
  const sideRosters = resolveSideRosters(def, row.room, sides);

  const section = document.createElement("section");
  section.className = "card form-card";
  const headingId = `ballot-heading-${def.id}`;
  section.setAttribute("aria-labelledby", headingId);

  const heading = document.createElement("h2");
  heading.id = headingId;
  heading.textContent = def.title ?? t("ballot.heading");
  section.append(heading);

  if (def.intro || preferences?.ballotIntroExplanation) {
    const intro = document.createElement("p");
    intro.className = "hint";
    intro.textContent = def.intro ?? preferences?.ballotIntroExplanation ?? "";
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

  // Optional motion selection if multiple motions released.
  let motionSelect: HTMLSelectElement | null = null;
  if (motions.length > 1) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `ballot-motion-${def.id}`;
    label.textContent = t("ballot.motionLabel");
    motionSelect = document.createElement("select");
    motionSelect.id = `ballot-motion-${def.id}`;
    motionSelect.name = "motionId";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = t("ballot.chooseMotion");
    motionSelect.append(blank);
    for (const m of motions) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.text;
      motionSelect.append(opt);
    }
    if (initialDraft?.motionId) {
      motionSelect.value = initialDraft.motionId;
    }
    field.append(label, motionSelect);
    form.append(field);
  }

  // Substitution flag (spec section 7).
  const subRow = document.createElement("div");
  subRow.className = "checkbox-row";
  const subCheckbox = document.createElement("input");
  subCheckbox.type = "checkbox";
  subCheckbox.id = `ballot-sub-${def.id}`;
  subCheckbox.name = "substitution";
  subCheckbox.checked = initialDraft?.substitution === true;
  const subLabel = document.createElement("label");
  subLabel.htmlFor = subCheckbox.id;
  subLabel.textContent = t("ballot.substitutionLabel");
  subRow.append(subCheckbox, subLabel);
  form.append(subRow);

  // Optional forfeit (two-team when enabled).
  let forfeitSelect: HTMLSelectElement | null = null;
  if (twoTeam && preferences?.enableForfeits) {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `ballot-forfeit-${def.id}`;
    label.textContent = t("ballot.forfeitLabel");
    forfeitSelect = document.createElement("select");
    forfeitSelect.id = `ballot-forfeit-${def.id}`;
    forfeitSelect.name = "forfeitSide";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = t("ballot.forfeitNone");
    forfeitSelect.append(noneOpt);
    for (const side of sides) {
      const opt = document.createElement("option");
      opt.value = side;
      opt.textContent = sideLabel(side, preferences, "full");
      forfeitSelect.append(opt);
    }
    if (initialDraft?.forfeitSide) {
      forfeitSelect.value = initialDraft.forfeitSide;
    }
    field.append(label, forfeitSelect);
    form.append(field);
  }

  // Two-team winning team radios when winner is declared explicitly or scores are omitted.
  const declaresWinner =
    twoTeam && (winnerDeclarationFor(preferences) !== "none" || !scored);
  const winnerRadios: HTMLInputElement[] = [];
  if (declaresWinner) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "field";
    const legend = document.createElement("legend");
    legend.textContent = t("ballot.winnerLegend");
    fieldset.append(legend);

    for (const side of sides) {
      const radioRow = document.createElement("div");
      radioRow.className = "radio-row";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `winner-${def.id}`;
      radio.id = `winner-${def.id}-${side}`;
      radio.value = side;
      if (initialDraft?.winner === side) {
        radio.checked = true;
      }
      const lbl = document.createElement("label");
      lbl.htmlFor = radio.id;
      const teamName = sideRosters[side]?.teamName;
      const sideText = sideLabel(side, preferences, "full");
      lbl.textContent = teamName ? `${sideText} — ${teamName}` : sideText;
      radioRow.append(radio, lbl);
      fieldset.append(radioRow);
      winnerRadios.push(radio);
    }
    form.append(fieldset);
  }

  // Optional 2:1 self-split decision.
  let selfSplitCheckbox: HTMLInputElement | null = null;
  if (
    twoTeam &&
    def.mode === "voting_sheet" &&
    selfSplitAllowed(
      { format: formsFile.format, preferences, stage: formsFile.stage },
      def.votingAdjudicatorCount ?? 1,
    )
  ) {
    const splitRow = document.createElement("div");
    splitRow.className = "checkbox-row";
    selfSplitCheckbox = document.createElement("input");
    selfSplitCheckbox.type = "checkbox";
    selfSplitCheckbox.id = `ballot-split-${def.id}`;
    selfSplitCheckbox.name = "selfSplit";
    selfSplitCheckbox.checked = initialDraft?.selfSplit === true;
    const splitLbl = document.createElement("label");
    splitLbl.htmlFor = selfSplitCheckbox.id;
    splitLbl.textContent = t("ballot.selfSplitLabel");
    splitRow.append(selfSplitCheckbox, splitLbl);
    form.append(splitRow);
  }

  const rankSelects = new Map<DebateSide, HTMLSelectElement>();
  const controlsBySide = new Map<DebateSide, SpeechControls[]>();
  const totalEls = new Map<DebateSide, HTMLElement>();

  const minSub = preferences?.minSpeakerScore ?? 68;
  const maxSub = preferences?.maxSpeakerScore ?? 84;
  const stepSub = preferences?.stepSpeakerScore ?? 1;
  const minReply = preferences?.minReplyScore ?? 34;
  const maxReply = preferences?.maxReplyScore ?? 42;
  const stepReply = preferences?.stepReplyScore ?? stepSub / 2;

  for (const side of sides) {
    const roster = sideRosters[side];
    const sideText = sideLabel(side, preferences, "full");
    const teamHeadingText = roster?.teamName
      ? `${sideText} — ${roster.teamName}`
      : sideText;

    const sideGroup = document.createElement("fieldset");
    sideGroup.className = "side-group";
    const legend = document.createElement("legend");
    legend.textContent = teamHeadingText;
    sideGroup.append(legend);

    // BP rank selector (or poly rank selector).
    if (!twoTeam) {
      const rankField = document.createElement("div");
      rankField.className = "field";
      const rankLabel = document.createElement("label");
      rankLabel.htmlFor = `rank-${def.id}-${side}`;
      rankLabel.textContent = t("ballot.rankLabel", { side: sideLabel(side, preferences, "abbr") });
      const rankSelect = document.createElement("select");
      rankSelect.id = `rank-${def.id}-${side}`;
      rankSelect.name = `rank-${side}`;
      const blankOpt = document.createElement("option");
      blankOpt.value = "";
      blankOpt.textContent = t("ballot.chooseRank");
      rankSelect.append(blankOpt);
      for (let r = 1; r <= sides.length; r++) {
        const opt = document.createElement("option");
        opt.value = String(r);
        opt.textContent = t("ballot.rankOption", { rank: r });
        rankSelect.append(opt);
      }
      const draftRank = initialDraft?.ranks?.[side];
      if (draftRank !== undefined) {
        rankSelect.value = String(draftRank);
      }
      rankField.append(rankLabel, rankSelect);
      sideGroup.append(rankField);
      rankSelects.set(side, rankSelect);
    }

    const sideControls: SpeechControls[] = [];
    const totalSpeeches = scored ? substantive + (replies ? 1 : 0) : 0;

    for (let idx = 0; idx < totalSpeeches; idx++) {
      const position = idx + 1;
      const isReply = replies && position > substantive;
      const draftSpeech = initialDraft?.speakerScores?.[side]?.[idx];
      const speechBox = document.createElement("div");
      speechBox.className = "speech-row";

      const spkField = document.createElement("div");
      spkField.className = "field";
      const spkLabel = document.createElement("label");
      spkLabel.htmlFor = `spk-${def.id}-${side}-${position}`;
      spkLabel.textContent = isReply
        ? t("ballot.replySpeakerLabel")
        : t("ballot.speakerLabel", { position });

      const speakerSelect = document.createElement("select");
      speakerSelect.id = `spk-${def.id}-${side}-${position}`;
      speakerSelect.name = `speaker-${side}-${position}`;
      const speakers = roster?.speakers ?? [];

      if (speakers.length === 0) {
        const opt = document.createElement("option");
        opt.value = `${side}-spk-${position}`;
        opt.textContent = isReply
          ? t("ballot.replySpeakerLabel")
          : t("ballot.speakerLabel", { position });
        speakerSelect.append(opt);
      } else {
        const choose = document.createElement("option");
        choose.value = "";
        choose.textContent = t("ballot.chooseSpeaker");
        speakerSelect.append(choose);
        for (const sp of speakers) {
          const opt = document.createElement("option");
          opt.value = sp.id;
          opt.textContent = sp.name;
          speakerSelect.append(opt);
        }
        const defaultSpeaker =
          draftSpeech?.speakerId ??
          (isReply ? speakers[0]?.id : speakers[idx]?.id ?? speakers[0]?.id);
        if (defaultSpeaker) {
          speakerSelect.value = defaultSpeaker;
        }
      }
      spkField.append(spkLabel, speakerSelect);
      speechBox.append(spkField);

      const speechCriteria = criteriaForSpeech(criteria, isReply);
      const criterionInputs = new Map<string, { input: HTMLInputElement; error: HTMLElement }>();
      let scoreInput: HTMLInputElement | null = null;
      let scoreError: HTMLElement | null = null;

      if (speechCriteria.length > 0) {
        for (const crit of speechCriteria) {
          const cField = document.createElement("div");
          cField.className = "field";
          const cLabel = document.createElement("label");
          cLabel.htmlFor = `crit-${def.id}-${side}-${position}-${crit.id}`;
          cLabel.textContent = t("ballot.criterionLabel", {
            name: crit.name,
            min: crit.minScore,
            max: crit.maxScore,
            step: crit.step,
          });
          const cInput = document.createElement("input");
          cInput.type = "text";
          cInput.inputMode = "decimal";
          cInput.id = `crit-${def.id}-${side}-${position}-${crit.id}`;
          cInput.name = `crit-${side}-${position}-${crit.id}`;
          cInput.setAttribute("aria-invalid", "false");
          if (draftSpeech?.criteria?.[crit.id] !== undefined) {
            cInput.value = String(draftSpeech.criteria[crit.id]);
          }
          const cErr = document.createElement("p");
          cErr.id = `crit-err-${def.id}-${side}-${position}-${crit.id}`;
          cErr.className = "field-error";
          cErr.hidden = true;

          cInput.addEventListener("blur", () => {
            const raw = cInput.value.trim();
            const num = raw.length === 0 ? undefined : Number(raw);
            const msg = validateCriterionScore(crit, num);
            setFieldValidity(cInput, cErr, msg);
          });
          cInput.addEventListener("input", () => {
            setFieldValidity(cInput, cErr, "");
            updateTotalsAndDraft();
          });

          cField.append(cLabel, cInput, cErr);
          speechBox.append(cField);
          criterionInputs.set(crit.id, { input: cInput, error: cErr });
        }
      } else {
        const scField = document.createElement("div");
        scField.className = "field";
        const scLabel = document.createElement("label");
        scLabel.htmlFor = `score-${def.id}-${side}-${position}`;
        scLabel.textContent = isReply
          ? t("ballot.replyScoreLabel", { min: minReply, max: maxReply, step: stepReply })
          : t("ballot.scoreLabel", { min: minSub, max: maxSub, step: stepSub });

        scoreInput = document.createElement("input");
        scoreInput.type = "text";
        scoreInput.inputMode = "decimal";
        scoreInput.id = `score-${def.id}-${side}-${position}`;
        scoreInput.name = `score-${side}-${position}`;
        scoreInput.required = true;
        scoreInput.setAttribute("aria-invalid", "false");
        if (draftSpeech && Number.isFinite(draftSpeech.score)) {
          scoreInput.value = String(draftSpeech.score);
        }

        scoreError = document.createElement("p");
        scoreError.id = `score-err-${def.id}-${side}-${position}`;
        scoreError.className = "field-error";
        scoreError.hidden = true;

        const inputRef = scoreInput;
        const errRef = scoreError;
        inputRef.addEventListener("blur", () => {
          const raw = inputRef.value.trim();
          if (raw.length === 0) return;
          const num = Number(raw);
          const check = isReply
            ? validateReplyScore(num, preferences)
            : validateSpeakerScore(num, preferences);
          setFieldValidity(inputRef, errRef, check.valid ? "" : check.error ?? "Invalid score.");
        });
        inputRef.addEventListener("input", () => {
          setFieldValidity(inputRef, errRef, "");
          updateTotalsAndDraft();
        });

        scField.append(scLabel, scoreInput, scoreError);
        speechBox.append(scField);
      }

      let ghostCheckbox: HTMLInputElement | null = null;
      if (!isReply && twoTeam) {
        const ghostRow = document.createElement("div");
        ghostRow.className = "checkbox-row";
        ghostCheckbox = document.createElement("input");
        ghostCheckbox.type = "checkbox";
        ghostCheckbox.id = `ghost-${def.id}-${side}-${position}`;
        ghostCheckbox.name = `ghost-${side}-${position}`;
        ghostCheckbox.checked = draftSpeech?.ghost === true;
        const ghostLbl = document.createElement("label");
        ghostLbl.htmlFor = ghostCheckbox.id;
        ghostLbl.textContent = t("ballot.ghostLabel");
        ghostCheckbox.addEventListener("change", updateTotalsAndDraft);
        ghostRow.append(ghostCheckbox, ghostLbl);
        speechBox.append(ghostRow);
      }

      speakerSelect.addEventListener("change", updateTotalsAndDraft);
      sideGroup.append(speechBox);

      sideControls.push({
        position,
        isReply,
        speakerSelect,
        scoreInput,
        scoreError,
        criterionInputs,
        ghostCheckbox,
      });
    }

    if (scored) {
      const totalEl = document.createElement("p");
      totalEl.className = "team-total";
      totalEl.textContent = t("ballot.teamTotal", { total: 0 });
      sideGroup.append(totalEl);
      totalEls.set(side, totalEl);
    }

    controlsBySide.set(side, sideControls);
    form.append(sideGroup);
  }

  function buildBallotEntry(): BallotEntry {
    const speakerScores: SideRecord<SpeakerScoreEntry[]> = {};
    for (const side of sides) {
      const list = controlsBySide.get(side) ?? [];
      speakerScores[side] = list.map((ctrl) => {
        const selectedOpt = ctrl.speakerSelect.selectedOptions[0];
        const speakerId = ctrl.speakerSelect.value;
        const speakerName = selectedOpt ? selectedOpt.textContent ?? "" : "";
        if (ctrl.criterionInputs.size > 0) {
          const critMap: Record<string, number> = {};
          for (const [cid, pair] of ctrl.criterionInputs.entries()) {
            const raw = pair.input.value.trim();
            if (raw.length > 0) {
              const num = Number(raw);
              if (Number.isFinite(num)) {
                critMap[cid] = num;
              }
            }
          }
          return {
            speakerId,
            speakerName,
            position: ctrl.position,
            score: 0,
            ...(ctrl.ghostCheckbox?.checked ? { ghost: true } : {}),
            criteria: critMap,
          };
        }
        const raw = ctrl.scoreInput?.value.trim() ?? "";
        const num = raw.length === 0 ? Number.NaN : Number(raw);
        return {
          speakerId,
          speakerName,
          position: ctrl.position,
          score: num,
          ...(ctrl.ghostCheckbox?.checked ? { ghost: true } : {}),
        };
      });
    }

    let ranks: SideRecord<number> | undefined;
    if (!twoTeam) {
      ranks = {};
      for (const side of sides) {
        const val = rankSelects.get(side)?.value ?? "";
        if (val.length > 0) {
          ranks[side] = Number(val);
        }
      }
    } else if (declaresWinner) {
      const chosen = winnerRadios.find((r) => r.checked)?.value as DebateSide | undefined;
      if (chosen) {
        const other = sides.find((s) => s !== chosen)!;
        ranks = { [chosen]: 1, [other]: 2 };
      } else {
        ranks = {};
      }
    }

    const forfeitVal = forfeitSelect?.value as DebateSide | "" | undefined;
    const motionVal = motionSelect?.value ?? (motions.length === 1 ? motions[0].id : undefined);

    return {
      speakerScores,
      ...(ranks ? { ranks } : {}),
      ...(forfeitVal ? { forfeitSide: forfeitVal } : {}),
      ...(motionVal ? { motionId: motionVal } : {}),
      ...(selfSplitCheckbox?.checked ? { selfSplit: true } : {}),
    };
  }

  function buildDraftData(): BallotDraftData {
    const entry = buildBallotEntry();
    const chosen = winnerRadios.find((r) => r.checked)?.value as DebateSide | undefined;
    return {
      motionId: entry.motionId,
      substitution: subCheckbox.checked,
      forfeitSide: entry.forfeitSide,
      selfSplit: entry.selfSplit,
      ranks: entry.ranks,
      winner: chosen,
      speakerScores: entry.speakerScores,
    };
  }

  function updateTotalsAndDraft(): void {
    const entry = buildBallotEntry();
    for (const side of sides) {
      const totalEl = totalEls.get(side);
      if (!totalEl) continue;
      const applied = applyScoreCriteria(entry.speakerScores[side] ?? [], effectiveRules);
      const total = cleanScore(teamSpeakerTotal(applied, effectiveRules));
      totalEl.textContent = t("ballot.teamTotal", { total });
    }
    onDraftChange?.(buildDraftData());
  }

  motionSelect?.addEventListener("change", updateTotalsAndDraft);
  subCheckbox.addEventListener("change", updateTotalsAndDraft);
  forfeitSelect?.addEventListener("change", updateTotalsAndDraft);
  selfSplitCheckbox?.addEventListener("change", updateTotalsAndDraft);
  for (const r of winnerRadios) r.addEventListener("change", updateTotalsAndDraft);
  for (const sel of rankSelects.values()) sel.addEventListener("change", updateTotalsAndDraft);

  function buildValidationContext(): BallotValidationContext {
    const rosters: SideRecord<Speaker[]> = {};
    for (const side of sides) {
      const roster = sideRosters[side];
      if (roster && roster.speakers.length > 0) {
        rosters[side] = roster.speakers.map((sp) => ({
          id: sp.id,
          name: sp.name,
        }));
      } else {
        rosters[side] = Array.from({ length: substantive }, (_, i) => ({
          id: `${side}-spk-${i + 1}`,
          name: `${side} ${i + 1}`,
        }));
      }
    }
    return {
      ...effectiveRules,
      rosters,
      roundMotionIds: motions.map((m) => m.id),
      ...(def.votingAdjudicatorCount !== undefined
        ? { votingAdjudicatorCount: def.votingAdjudicatorCount }
        : {}),
    };
  }

  function validateAll(): { valid: boolean; errors: string[]; entry: BallotEntry } {
    const entry = buildBallotEntry();
    const ctx = buildValidationContext();

    // Update per-field ARIA states before full ballot check.
    for (const side of sides) {
      for (const ctrl of controlsBySide.get(side) ?? []) {
        if (ctrl.scoreInput && ctrl.scoreError) {
          const raw = ctrl.scoreInput.value.trim();
          const num = raw.length === 0 ? Number.NaN : Number(raw);
          const check = ctrl.isReply
            ? validateReplyScore(num, preferences)
            : validateSpeakerScore(num, preferences);
          setFieldValidity(
            ctrl.scoreInput,
            ctrl.scoreError,
            check.valid ? "" : check.error ?? "Invalid score.",
          );
        }
        for (const [cid, pair] of ctrl.criterionInputs.entries()) {
          const crit = criteria.find((c) => c.id === cid);
          if (crit) {
            const raw = pair.input.value.trim();
            const num = raw.length === 0 ? undefined : Number(raw);
            setFieldValidity(pair.input, pair.error, validateCriterionScore(crit, num));
          }
        }
      }
    }

    const errors = validateBallotEntry(entry, ctx);
    if (errors.length === 0) {
      errorSummary.hidden = true;
      errorSummary.replaceChildren();
      return { valid: true, errors: [], entry };
    }

    errorSummary.hidden = false;
    const summaryTitle = document.createElement("p");
    summaryTitle.textContent = t("form.validationSummary", { count: errors.length });
    const list = document.createElement("ul");
    for (const msg of errors) {
      const li = document.createElement("li");
      li.textContent = msg;
      list.append(li);
    }
    errorSummary.replaceChildren(summaryTitle, list);
    announcer.announceAssertive(errors[0]);
    focusFirstError(form);
    return { valid: false, errors, entry };
  }

  function entryToPayload(entry: BallotEntry): Record<string, unknown> {
    const teamIds: SideRecord<string> = {};
    for (const side of sides) {
      teamIds[side] = sideRosters[side]?.teamId ?? "";
    }
    const applied: SideRecord<SpeakerScoreEntry[]> = {};
    for (const side of sides) {
      applied[side] = applyScoreCriteria(entry.speakerScores[side] ?? [], effectiveRules);
    }
    const ranks = effectiveRanks(applied, entry.ranks, effectiveRules);
    const teamScores = consensusTeamScores(applied, ranks, teamIds, effectiveRules);

    return {
      formId: def.id,
      mode: def.mode,
      room: row.room,
      substitution: subCheckbox.checked,
      ...(entry.motionId ? { motionId: entry.motionId } : {}),
      ...(entry.forfeitSide ? { forfeitSide: entry.forfeitSide } : {}),
      ...(entry.selfSplit ? { selfSplit: true } : {}),
      speakerScores: applied,
      ranks,
      teamScores,
    };
  }

  // Action buttons.
  const actions = document.createElement("div");
  actions.className = "actions-row";

  const primaryBtn = document.createElement("button");
  primaryBtn.type = "submit";
  primaryBtn.className = "btn btn-primary";
  primaryBtn.textContent =
    mode === "qr_only" ? t("form.showBallotQr") : t("form.submitBallot");
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
    const result = validateAll();
    if (!result.valid) return;
    const payload = entryToPayload(result.entry);
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
        mode === "qr_only" ? t("form.showBallotQr") : t("form.submitBallot");
      syncDisabled();
    }
  });

  qrInsteadBtn?.addEventListener("click", async () => {
    if (isLocked || isSubmitting) return;
    const result = validateAll();
    if (!result.valid) return;
    const payload = entryToPayload(result.entry);
    await onShowQr(payload);
  });

  updateTotalsAndDraft();
  syncDisabled();

  return {
    element: section,
    setLocked(locked: boolean): void {
      isLocked = locked;
      syncDisabled();
    },
    setSubmitting(submitting: boolean): void {
      isSubmitting = submitting;
      syncDisabled();
    },
    getPayload(): Record<string, unknown> | null {
      const entry = buildBallotEntry();
      const errors = validateBallotEntry(entry, buildValidationContext());
      if (errors.length > 0) {
        return null;
      }
      return entryToPayload(entry);
    },
  };
}
