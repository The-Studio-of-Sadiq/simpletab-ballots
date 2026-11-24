import type { TranslateFn } from "../i18n";
import type { BallotCollectionMode, CheckInFormDefinition } from "../manifest";

export interface RenderCheckInFormOptions {
  def: CheckInFormDefinition;
  mode: BallotCollectionMode;
  initialAvailable?: boolean;
  t: TranslateFn;
  onSubmitOnline: (payload: Record<string, unknown>) => Promise<void>;
  onShowQr: (payload: Record<string, unknown>) => Promise<void>;
}

export function renderCheckInForm(options: RenderCheckInFormOptions): HTMLElement {
  const { def, mode, initialAvailable = true, t, onSubmitOnline, onShowQr } = options;

  const section = document.createElement("section");
  section.className = "card form-card";
  const headingId = `checkin-heading-${def.id}`;
  section.setAttribute("aria-labelledby", headingId);

  const heading = document.createElement("h2");
  heading.id = headingId;
  heading.textContent = def.title ?? t("checkin.heading");
  section.append(heading);

  if (def.prompt) {
    const prompt = document.createElement("p");
    prompt.className = "hint";
    prompt.textContent = def.prompt;
    section.append(prompt);
  }

  const form = document.createElement("form");
  form.setAttribute("aria-labelledby", headingId);

  const fieldset = document.createElement("fieldset");
  fieldset.className = "field";
  const legend = document.createElement("legend");
  legend.textContent = def.roundName;
  fieldset.append(legend);

  const yesRow = document.createElement("div");
  yesRow.className = "radio-row";
  const yesRadio = document.createElement("input");
  yesRadio.type = "radio";
  yesRadio.id = `checkin-yes-${def.id}`;
  yesRadio.name = `checkin-${def.id}`;
  yesRadio.value = "available";
  yesRadio.checked = initialAvailable;
  const yesLabel = document.createElement("label");
  yesLabel.htmlFor = yesRadio.id;
  yesLabel.textContent = t("checkin.available", { roundName: def.roundName });
  yesRow.append(yesRadio, yesLabel);

  const noRow = document.createElement("div");
  noRow.className = "radio-row";
  const noRadio = document.createElement("input");
  noRadio.type = "radio";
  noRadio.id = `checkin-no-${def.id}`;
  noRadio.name = `checkin-${def.id}`;
  noRadio.value = "unavailable";
  noRadio.checked = !initialAvailable;
  const noLabel = document.createElement("label");
  noLabel.htmlFor = noRadio.id;
  noLabel.textContent = t("checkin.unavailable", { roundName: def.roundName });
  noRow.append(noRadio, noLabel);

  fieldset.append(yesRow, noRow);
  form.append(fieldset);

  const actions = document.createElement("div");
  actions.className = "actions-row";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-primary";
  submitBtn.textContent =
    mode === "qr_only" ? t("form.showCheckinQr") : t("form.submitCheckin");
  actions.append(submitBtn);

  form.append(actions);
  section.append(form);

  let isSubmitting = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = t("form.submitting");
    const payload: Record<string, unknown> = {
      formId: def.id,
      roundId: def.roundId,
      available: yesRadio.checked,
    };
    try {
      if (mode === "qr_only") {
        await onShowQr(payload);
      } else {
        await onSubmitOnline(payload);
      }
    } finally {
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent =
        mode === "qr_only" ? t("form.showCheckinQr") : t("form.submitCheckin");
    }
  });

  return section;
}
