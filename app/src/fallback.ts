import { encodeQrBallot, type QrBallotEnvelope } from "@simpletab/core/crypto";
import qrcode from "qrcode-generator";
import type { TranslateFn } from "./i18n";

export type FallbackReason = "quota" | "offline" | "deadline" | "qr_only" | "manual";

export interface FallbackPanelOptions {
  codes: readonly string[];
  reason: FallbackReason;
  t: TranslateFn;
  onClose?: () => void;
}

/**
 * Encodes and signs a submission payload as 1..4 QR codes using core's `encodeQrBallot`.
 */
export async function encodeFallbackCodes(
  qrKey: Uint8Array,
  envelope: QrBallotEnvelope,
): Promise<string[]> {
  return encodeQrBallot(qrKey, envelope);
}

/**
 * Renders a crisp, accessible inline SVG QR code from `data` (Error Correction L, Byte mode).
 */
export function renderQrSvg(data: string, ariaLabel: string): SVGSVGElement {
  const qr = qrcode(0, "L");
  qr.addData(data, "Byte");
  qr.make();

  const count = qr.getModuleCount();
  const margin = 2;
  const total = count + margin * 2;
  const ns = "http://www.w3.org/2000/svg";

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", ariaLabel);
  svg.setAttribute("class", "qr-svg");
  svg.setAttribute("shape-rendering", "crispEdges");

  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", String(total));
  bg.setAttribute("height", String(total));
  bg.setAttribute("fill", "#ffffff");
  svg.append(bg);

  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        d += `M${col + margin},${row + margin}h1v1h-1z`;
      }
    }
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(path);

  return svg;
}

function reasonKey(reason: FallbackReason): string {
  switch (reason) {
    case "quota":
      return "fallback.reason.quota";
    case "offline":
      return "fallback.reason.offline";
    case "deadline":
      return "fallback.reason.deadline";
    case "qr_only":
      return "fallback.reason.qrOnly";
    case "manual":
      return "fallback.reason.manual";
  }
}

/**
 * Renders the signed QR fallback panel: one QR code at a time with fragment
 * navigation (`1 of 2`) and a copyable signed text code.
 */
export function renderFallbackPanel(options: FallbackPanelOptions): HTMLElement {
  const { codes, reason, t, onClose } = options;
  if (codes.length === 0) {
    throw new Error("Fallback panel requires at least one encoded QR code.");
  }

  const section = document.createElement("section");
  section.className = "card fallback-panel";
  section.setAttribute("aria-labelledby", "fallback-heading");

  const heading = document.createElement("h2");
  heading.id = "fallback-heading";
  heading.tabIndex = -1;
  heading.textContent = t("fallback.heading");

  const reasonPara = document.createElement("p");
  reasonPara.className = reason === "deadline" ? "fallback-reason fallback-reason-urgent" : "fallback-reason";
  reasonPara.textContent = t(reasonKey(reason));

  const qrStage = document.createElement("div");
  qrStage.className = "qr-stage";

  let currentIndex = 0;

  const counter = document.createElement("p");
  counter.className = "qr-counter";
  counter.setAttribute("aria-live", "polite");

  const nav = document.createElement("div");
  nav.className = "qr-nav";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn btn-secondary";
  prevBtn.textContent = t("fallback.prevFragment");

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn-secondary";
  nextBtn.textContent = t("fallback.nextFragment");

  function updateQrView(): void {
    const code = codes[currentIndex];
    const alt = t("fallback.qrAlt", {
      current: currentIndex + 1,
      total: codes.length,
    });
    qrStage.replaceChildren(renderQrSvg(code, alt));
    counter.textContent = t("fallback.fragmentCounter", {
      current: currentIndex + 1,
      total: codes.length,
    });
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= codes.length - 1;
  }

  prevBtn.addEventListener("click", () => {
    if (currentIndex > 0) {
      currentIndex -= 1;
      updateQrView();
    }
  });
  nextBtn.addEventListener("click", () => {
    if (currentIndex < codes.length - 1) {
      currentIndex += 1;
      updateQrView();
    }
  });

  if (codes.length > 1) {
    nav.append(prevBtn, counter, nextBtn);
  } else {
    counter.hidden = true;
    nav.hidden = true;
  }

  const codeField = document.createElement("div");
  codeField.className = "field";

  const codeLabel = document.createElement("label");
  codeLabel.htmlFor = "fallback-text-code";
  codeLabel.textContent = t("fallback.codeLabel");

  const textarea = document.createElement("textarea");
  textarea.id = "fallback-text-code";
  textarea.name = "qrTextCode";
  textarea.readOnly = true;
  textarea.rows = Math.min(6, Math.max(3, codes.length + 1));
  textarea.value = codes.join("\n");
  textarea.className = "code-box";

  const actions = document.createElement("div");
  actions.className = "actions-row";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-secondary";
  copyBtn.textContent = t("fallback.copyButton");

  const copyStatus = document.createElement("p");
  copyStatus.className = "hint";
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");

  copyBtn.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(textarea.value);
      } else {
        textarea.focus();
        textarea.select();
        const copied = document.execCommand?.("copy");
        if (!copied) {
          throw new Error("Copy unavailable");
        }
      }
      copyStatus.textContent = t("fallback.copied");
    } catch {
      copyStatus.textContent = t("fallback.copyFailed");
    }
  });

  actions.append(copyBtn);

  if (onClose) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn btn-secondary";
    closeBtn.textContent = t("fallback.close");
    closeBtn.addEventListener("click", onClose);
    actions.append(closeBtn);
  }

  codeField.append(codeLabel, textarea, actions, copyStatus);

  section.append(heading, reasonPara, qrStage, nav, codeField);
  updateQrView();
  return section;
}
