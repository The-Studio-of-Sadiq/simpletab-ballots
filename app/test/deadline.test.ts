import { describe, expect, it, vi } from "vitest";
import {
  computeDeadlineState,
  formatDeadlineTime,
  mountDeadlineBanner,
} from "../src/deadline";
import { createI18n } from "../src/i18n";

describe("deadline display, countdown, urgent warning, and lock", () => {
  const { t } = createI18n("en");
  // 2026-11-24T08:00:00.000Z = 14:00 (2:00 PM) in Asia/Dhaka (+06:00).
  const deadlineIso = "2026-11-24T08:00:00.000Z";
  const deadlineMs = Date.parse(deadlineIso);

  it("formats deadline in tournament timezone and shows countdown in the last 30 minutes", () => {
    const formatted = formatDeadlineTime(deadlineIso, "Asia/Dhaka", "en");
    expect(formatted.timeText).toMatch(/2:00\s*PM/i);

    let nowMs = deadlineMs - 45 * 60_000;
    const banner = mountDeadlineBanner({
      deadlineIso,
      timeZone: "Asia/Dhaka",
      roundName: "Round 2",
      mode: "online",
      locale: "en",
      now: () => nowMs,
      hasUnsentBallot: () => false,
      t,
    });

    // 45 minutes out: shows closing time, no countdown yet.
    expect(banner.element.textContent).toContain("Ballots close at");
    expect(banner.element.textContent).not.toContain("minutes left");

    // 15 minutes out: shows countdown.
    nowMs = deadlineMs - 15 * 60_000;
    banner.update();
    expect(banner.element.textContent).toContain("15 minutes left");

    banner.destroy();
  });

  it("shows large urgent warning under 10 minutes when a ballot is saved on phone only", () => {
    let nowMs = deadlineMs - 5 * 60_000;
    let hasUnsent = true;
    const onLockChange = vi.fn();

    const banner = mountDeadlineBanner({
      deadlineIso,
      timeZone: "Asia/Dhaka",
      roundName: "Round 2",
      mode: "online",
      locale: "en",
      now: () => nowMs,
      hasUnsentBallot: () => hasUnsent,
      t,
      onLockChange,
    });

    const urgentEl = banner.element.querySelector<HTMLElement>(".deadline-urgent")!;
    expect(urgentEl.hidden).toBe(false);
    expect(urgentEl.textContent).toContain("saved on this phone only");
    expect(urgentEl.textContent).toContain("5 minutes");

    // Once ballot is sent, urgent warning hides.
    hasUnsent = false;
    banner.update();
    expect(urgentEl.hidden).toBe(true);

    // At deadline, form locks and closed message displays.
    nowMs = deadlineMs;
    banner.update();
    expect(banner.isLocked()).toBe(true);
    expect(onLockChange).toHaveBeenLastCalledWith(true);
    expect(banner.element.textContent).toContain(
      "Ballot submission for Round 2 closed at",
    );
    expect(banner.element.textContent).toContain("Give your ballot to the Tab director");

    banner.destroy();
  });

  it("disables deadline enforcement in qr_only mode", () => {
    const state = computeDeadlineState({
      deadlineIso,
      nowMs: deadlineMs + 60_000,
      hasUnsentBallot: true,
      mode: "qr_only",
    });
    expect(state.active).toBe(false);
    expect(state.locked).toBe(false);
  });
});
