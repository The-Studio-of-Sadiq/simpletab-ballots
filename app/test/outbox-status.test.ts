import { SCHEMA_VERSION } from "@simpletab/core/wire";
import { beforeEach, describe, expect, it } from "vitest";
import { bootApp, type AppHandle } from "../src/main";
import { OutboxManager, statusTextForState } from "../src/outbox";
import { createI18n } from "../src/i18n";
import { createCdnFetchMock, createRoundFixture } from "./fixtures";

describe("outbox persistence, retries, and 3 visible states", () => {
  const { t } = createI18n("en");

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it("keeps a ballot through a failed send and marks it received after 200 received or already_received", async () => {
    const fixture = await createRoundFixture();
    let nowMs = Date.UTC(2026, 10, 24, 12, 0, 0);
    const outbox = new OutboxManager({ now: () => nowMs });

    const rec = await outbox.enqueue({
      slug: fixture.link.slug,
      roundId: "round-1",
      lookupId: fixture.link.lookupId,
      formId: "ballot-1",
      type: "ballot",
      payload: { ranks: { OG: 1, OO: 2, CG: 3, CO: 4 } },
    });

    expect(rec.state).toBe("local_only");
    expect(statusTextForState(rec.state, t)).toBe("Saved on this phone only, don't leave");

    // 1. Network failure keeps record in local_only with retry scheduled.
    const failResult = await outbox.sendSubmission(
      rec.submissionId,
      fixture.keys,
      "https://ballots.simpletab.org",
      "online",
      async () => {
        throw new Error("Connection dropped");
      },
    );
    expect(failResult.outcome).toBe("retry_later");
    expect(failResult.record.state).toBe("local_only");

    const storedAfterFail = await outbox.get(rec.submissionId);
    expect(storedAfterFail?.state).toBe("local_only");
    expect(storedAfterFail?.attempts).toBe(1);

    // 2. Resend after backoff returns 200 { status: "already_received" } -> counts as received.
    nowMs += 10_000;
    const outcomes = await outbox.retryPending({
      slug: fixture.link.slug,
      lookupId: fixture.link.lookupId,
      keys: fixture.keys,
      apiOrigin: "https://ballots.simpletab.org",
      mode: "online",
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "already_received" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe("received");
    expect(outcomes[0].record.state).toBe("received_by_server");
    expect(statusTextForState(outcomes[0].record.state, t)).toBe("Received by server");

    // Also verify normal 200 { status: "received" }.
    const rec2 = await outbox.enqueue({
      slug: fixture.link.slug,
      roundId: "round-1",
      lookupId: fixture.link.lookupId,
      formId: "checkin-1",
      type: "checkin",
      payload: { available: true },
    });
    const okResult = await outbox.sendSubmission(
      rec2.submissionId,
      fixture.keys,
      "https://ballots.simpletab.org",
      "online",
      async () =>
        new Response(
          JSON.stringify({
            status: "received",
            submissionId: rec2.submissionId,
            receivedAt: "2026-11-24T12:00:10.000Z",
          }),
          { status: 200 },
        ),
    );
    expect(okResult.outcome).toBe("received");
    expect(okResult.record.state).toBe("received_by_server");

    await outbox.close();
  });

  it('shows "Received by tab room" in the UI after GET /v1/status returns tabRoom: true', async () => {
    const fixture = await createRoundFixture();
    const outbox = new OutboxManager();

    const rec = await outbox.enqueue({
      slug: fixture.link.slug,
      roundId: "round-1",
      lookupId: fixture.link.lookupId,
      formId: "ballot-1",
      type: "ballot",
      payload: { ranks: { OG: 1, OO: 2, CG: 3, CO: 4 } },
    });
    await outbox.put({
      ...rec,
      state: "received_by_server",
      nextRetryAt: null,
    });

    const fetchMock = createCdnFetchMock(fixture, async (url) => {
      if (url.includes("/v1/status")) {
        return new Response(
          JSON.stringify({
            schema: SCHEMA_VERSION,
            items: [{ submissionId: rec.submissionId, server: true, tabRoom: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const root = document.getElementById("app")!;
    const handle: AppHandle = await bootApp({
      root,
      locationHref: fixture.link.url,
      apiOrigin: "https://ballots.simpletab.org",
      fetchImpl: fetchMock,
      outbox,
      registerServiceWorker: false,
    });

    expect(root.textContent).toContain("Received by tab room");
    const updated = await outbox.get(rec.submissionId);
    expect(updated?.state).toBe("received_by_tab_room");

    handle.destroy();
    await outbox.close();
  });
});
