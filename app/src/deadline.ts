import type { TranslateFn } from "./i18n";
import type { BallotCollectionMode } from "./manifest";

export interface DeadlineState {
  active: boolean;
  locked: boolean;
  showCountdown: boolean;
  urgentUnsentWarning: boolean;
  remainingMs: number;
  remainingMinutes: number;
}

export interface DeadlineDisplayParams {
  deadlineIso?: string;
  timeZone: string;
  roundName: string;
  mode: BallotCollectionMode;
  locale: string;
  now?: () => number;
  hasUnsentBallot: () => boolean;
  t: TranslateFn;
  onLockChange?: (locked: boolean) => void;
}

export interface DeadlineController {
  element: HTMLElement;
  update(): DeadlineState;
  isLocked(): boolean;
  destroy(): void;
}

export const COUNTDOWN_WINDOW_MS = 30 * 60_000;
export const URGENT_WINDOW_MS = 10 * 60_000;

/**
 * Formats an ISO UTC instant into the tournament's IANA time zone.
 */
export function formatDeadlineTime(
  isoUtc: string,
  timeZone: string,
  locale: string,
): { timeText: string; zoneText: string } {
  const date = new Date(isoUtc);
  if (!Number.isFinite(date.getTime())) {
    return { timeText: isoUtc, zoneText: timeZone };
  }
  try {
    const timeText = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone,
      timeZoneName: "shortGeneric",
    }).formatToParts(date);
    const tzPart = parts.find((part) => part.type === "timeZoneName")?.value;
    return {
      timeText,
      zoneText: tzPart && tzPart.trim().length > 0 ? tzPart : timeZone,
    };
  } catch {
    const timeText = new Intl.DateTimeFormat("en", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return { timeText, zoneText: "UTC" };
  }
}

/**
 * Computes deadline state (active, locked, countdown <= 30 min, urgent < 10 min).
 * Deadlines are a portal rule and do not apply in `qr_only` mode.
 */
export function computeDeadlineState(params: {
  deadlineIso?: string;
  nowMs: number;
  hasUnsentBallot: boolean;
  mode: BallotCollectionMode;
}): DeadlineState {
  if (params.mode === "qr_only" || !params.deadlineIso) {
    return {
      active: false,
      locked: false,
      showCountdown: false,
      urgentUnsentWarning: false,
      remainingMs: Infinity,
      remainingMinutes: Infinity,
    };
  }

  const deadlineMs = Date.parse(params.deadlineIso);
  if (!Number.isFinite(deadlineMs)) {
    return {
      active: false,
      locked: false,
      showCountdown: false,
      urgentUnsentWarning: false,
      remainingMs: Infinity,
      remainingMinutes: Infinity,
    };
  }

  const remainingMs = deadlineMs - params.nowMs;
  const locked = remainingMs <= 0;
  const remainingMinutes = locked ? 0 : Math.ceil(remainingMs / 60_000);
  const showCountdown = !locked && remainingMs <= COUNTDOWN_WINDOW_MS;
  const urgentUnsentWarning =
    !locked && params.hasUnsentBallot && remainingMs < URGENT_WINDOW_MS;

  return {
    active: true,
    locked,
    showCountdown,
    urgentUnsentWarning,
    remainingMs,
    remainingMinutes,
  };
}

/**
 * Creates and maintains the deadline banner, 30-minute countdown, <10-minute
 * large unsent warning, and post-deadline lock notice.
 */
export function mountDeadlineBanner(params: DeadlineDisplayParams): DeadlineController {
  const container = document.createElement("section");
  container.className = "deadline-banner";
  container.setAttribute("aria-label", params.roundName);

  const primaryText = document.createElement("p");
  primaryText.className = "deadline-primary";

  const urgentWarning = document.createElement("p");
  urgentWarning.className = "deadline-urgent";
  urgentWarning.setAttribute("role", "alert");
  urgentWarning.hidden = true;

  container.append(primaryText, urgentWarning);

  const clock = params.now ?? Date.now;
  let lastLocked: boolean | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function render(): DeadlineState {
    const state = computeDeadlineState({
      deadlineIso: params.deadlineIso,
      nowMs: clock(),
      hasUnsentBallot: params.hasUnsentBallot(),
      mode: params.mode,
    });

    if (!state.active || !params.deadlineIso) {
      container.hidden = true;
      urgentWarning.hidden = true;
      if (lastLocked !== false) {
        lastLocked = false;
        params.onLockChange?.(false);
      }
      return state;
    }

    container.hidden = false;
    const { timeText, zoneText } = formatDeadlineTime(
      params.deadlineIso,
      params.timeZone,
      params.locale,
    );

    if (state.locked) {
      container.classList.add("deadline-locked");
      container.classList.remove("deadline-countdown");
      primaryText.textContent = params.t("deadline.closedNotice", {
        roundName: params.roundName,
        time: timeText,
      });
      urgentWarning.hidden = true;
    } else {
      container.classList.remove("deadline-locked");
      container.classList.toggle("deadline-countdown", state.showCountdown);
      primaryText.textContent = state.showCountdown
        ? params.t("deadline.closesWithCountdown", {
            time: timeText,
            timeZone: zoneText,
            minutes: state.remainingMinutes,
          })
        : params.t("deadline.closesAt", {
            time: timeText,
            timeZone: zoneText,
          });

      if (state.urgentUnsentWarning) {
        urgentWarning.hidden = false;
        urgentWarning.textContent = params.t("deadline.urgentUnsent", {
          minutes: state.remainingMinutes,
        });
      } else {
        urgentWarning.hidden = true;
        urgentWarning.textContent = "";
      }
    }

    if (lastLocked !== state.locked) {
      lastLocked = state.locked;
      params.onLockChange?.(state.locked);
    }

    if (state.locked && timer !== null) {
      clearInterval(timer);
      timer = null;
    }

    return state;
  }

  const initial = render();
  if (initial.active && !initial.locked && typeof setInterval === "function") {
    timer = setInterval(() => {
      render();
    }, 15_000);
  }

  return {
    element: container,
    update: render,
    isLocked: () => lastLocked === true,
    destroy: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
