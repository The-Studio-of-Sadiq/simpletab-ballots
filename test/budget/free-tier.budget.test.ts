import { describe, expect, it } from "vitest";
import {
  ALLOCATED_SHARE_WRITES_CAP,
  BUDGET_MAX_RATIO,
  BUDGET_REPORT_MARKER,
  FREE_DAILY_READS,
  FREE_DAILY_REQUESTS,
  FREE_DAILY_WRITES,
  SMALL100_PROFILE,
  WUDC_PROFILE,
  buildBudgetReport,
  measureInterleavedInboxReads,
  measurePerRouteWrites,
  replayTournamentDay,
} from "./replay";

describe("Free-tier budget replay and capacity verification", () => {
  it("stays within per-route write expectations and 90% of Cloudflare free-tier limits", async () => {
    // 1. Per-route D1 write probe (fails immediately if any secondary index is added).
    const tStart = performance.now();
    const perRoute = await measurePerRouteWrites();
    console.log(`[budget] per-route probe done in ${Math.round(performance.now() - tStart)}ms`);

    // 2. Full end-to-end replay of one 100-team day and one WUDC-size day.
    const tSmall = performance.now();
    const small100 = await replayTournamentDay(SMALL100_PROFILE);
    console.log(`[budget] 1x 100-team replay done in ${Math.round(performance.now() - tSmall)}ms (${small100.requests} reqs)`);

    const tWudc = performance.now();
    const wudc = await replayTournamentDay(WUDC_PROFILE);
    console.log(`[budget] 1x WUDC replay done in ${Math.round(performance.now() - tWudc)}ms (${wudc.requests} reqs)`);

    // 3. Real N-way interleaved inbox read measurements for 3× WUDC and 15× 100-team.
    const tInt3 = performance.now();
    const wudc3Interleaved = await measureInterleavedInboxReads({
      tournaments: 3,
      participantsPerTournament: WUDC_PROFILE.teams + WUDC_PROFILE.adjudicators,
      roomsPerTournament: WUDC_PROFILE.rooms,
      ticksPerRound: 300,
    });
    console.log(`[budget] 3x WUDC interleaved done in ${Math.round(performance.now() - tInt3)}ms`);

    const tInt15 = performance.now();
    const small100x15Interleaved = await measureInterleavedInboxReads({
      tournaments: 15,
      participantsPerTournament:
        SMALL100_PROFILE.teams + SMALL100_PROFILE.adjudicators,
      roomsPerTournament: SMALL100_PROFILE.rooms,
      ticksPerRound: 300,
      staggerOffsetTicks: 12, // 6 minutes offset per tournament for staggered sensitivity check
    });
    console.log(`[budget] 15x 100-team interleaved done in ${Math.round(performance.now() - tInt15)}ms`);

    const report = buildBudgetReport({
      perRoute,
      wudc,
      small100,
      wudc3Interleaved,
      small100x15Interleaved,
    });

    // Emit structured report for scripts/budget.mjs before assertions so failures still print full tables.
    console.log(`${BUDGET_REPORT_MARKER}${JSON.stringify(report)}`);

    // Assert per-route rows written (catches any accidental secondary index or write on /v1/status).
    for (const entry of perRoute) {
      expect(
        entry.measuredWrites,
        `${entry.route}: expected ${entry.expectedWrites} rows written, got ${entry.measuredWrites}`,
      ).toBe(entry.expectedWrites);
    }

    // Verify expected submission volumes were actually accepted in both replays.
    expect(wudc.counts.checkins).toBe(3_600);
    expect(wudc.counts.ballots).toBe(400);
    expect(wudc.counts.feedback).toBe(3_200);
    expect(wudc.counts.statusChecks).toBe(2_200);
    expect(wudc.counts.inboxPulls).toBe(1_200);

    expect(small100.counts.checkins).toBe(900);
    expect(small100.counts.ballots).toBe(100);
    expect(small100.counts.feedback).toBe(800);
    expect(small100.counts.statusChecks).toBe(552);
    expect(small100.counts.inboxPulls).toBe(1_200);

    // Staggered tournaments must not re-read each other's rows on quiet pulls (inbox `scanned`).
    expect(report.staggeredReads).toBeDefined();
    expect(report.staggeredReads!).toBeLessThanOrEqual(report.limits.rowsRead * report.limits.failRatio);

    // Assert all enforced capacity scenarios stay under 90% of every Cloudflare free limit
    // and under 80,000 allocated share writes.
    for (const scenario of report.scenarios) {
      if (!scenario.enforced) {
        continue;
      }
      expect(
        scenario.requests,
        `${scenario.name}: requests ${scenario.requests} exceed 90% of ${FREE_DAILY_REQUESTS}`,
      ).toBeLessThanOrEqual(FREE_DAILY_REQUESTS * BUDGET_MAX_RATIO);
      expect(
        scenario.rowsWritten,
        `${scenario.name}: rowsWritten ${scenario.rowsWritten} exceed 90% of ${FREE_DAILY_WRITES}`,
      ).toBeLessThanOrEqual(FREE_DAILY_WRITES * BUDGET_MAX_RATIO);
      expect(
        scenario.rowsRead,
        `${scenario.name}: rowsRead ${scenario.rowsRead} exceed 90% of ${FREE_DAILY_READS}`,
      ).toBeLessThanOrEqual(FREE_DAILY_READS * BUDGET_MAX_RATIO);
      expect(
        scenario.allocatedShareWrites,
        `${scenario.name}: allocatedShareWrites ${scenario.allocatedShareWrites} exceed ${ALLOCATED_SHARE_WRITES_CAP}`,
      ).toBeLessThanOrEqual(ALLOCATED_SHARE_WRITES_CAP);
    }
  });
});
