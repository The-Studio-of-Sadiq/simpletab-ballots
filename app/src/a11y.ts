/**
 * Accessibility helpers implementing live regions, ARIA invalid/describedby
 * synchronization, and submit error focus routing.
 */

export interface LiveAnnouncer {
  polite: HTMLElement;
  assertive: HTMLElement;
  announcePolite(message: string): void;
  announceAssertive(message: string): void;
}

export function createLiveAnnouncer(container: HTMLElement): LiveAnnouncer {
  const polite = document.createElement("div");
  polite.setAttribute("aria-live", "polite");
  polite.setAttribute("aria-atomic", "true");
  polite.className = "visually-hidden";

  const assertive = document.createElement("div");
  assertive.setAttribute("aria-live", "assertive");
  assertive.setAttribute("aria-atomic", "true");
  assertive.className = "visually-hidden";

  container.append(polite, assertive);

  return {
    polite,
    assertive,
    announcePolite(message: string): void {
      polite.textContent = "";
      polite.textContent = message;
    },
    announceAssertive(message: string): void {
      assertive.textContent = "";
      assertive.textContent = message;
    },
  };
}

/**
 * Synchronizes `aria-invalid` and links `errorEl.id` in `aria-describedby` ONLY
 * while the control is invalid so hidden error text is never announced early.
 */
export function setFieldValidity(
  control: HTMLElement,
  errorEl: HTMLElement,
  message: string,
): void {
  const errorId = errorEl.id;
  const existing = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((id) => id.length > 0 && id !== errorId);

  if (message.length > 0) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    control.setAttribute("aria-invalid", "true");
    if (errorId) {
      existing.push(errorId);
    }
  } else {
    errorEl.textContent = "";
    errorEl.hidden = true;
    control.setAttribute("aria-invalid", "false");
  }

  if (existing.length > 0) {
    control.setAttribute("aria-describedby", existing.join(" "));
  } else {
    control.removeAttribute("aria-describedby");
  }
}

/**
 * Moves focus to the error summary banner if present, or to the first invalid control.
 */
export function focusFirstError(container: HTMLElement): void {
  const summary = container.querySelector<HTMLElement>(".error-summary");
  if (summary && !summary.hidden) {
    summary.focus();
    return;
  }
  const firstInvalid = container.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (firstInvalid) {
    firstInvalid.focus();
  }
}
