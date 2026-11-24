import { decodeQrBallot, encodeQrBallot } from "@simpletab/core/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderFallbackPanel } from "../src/fallback";
import { createI18n } from "../src/i18n";
import { bootApp, type AppHandle } from "../src/main";
import { OutboxManager } from "../src/outbox";
import { createCdnFetchMock, createRoundFixture } from "./fixtures";

function fillValidBpBallot(root: HTMLElement): void {
  const setup: Array<[string, number, [number, number]]> = [
    ["OG", 1, [80, 80]],
    ["OO", 2, [78, 78]],
    ["CG", 3, [76, 76]],
    ["CO", 4, [74, 74]],
  ];
  for (const [side, rank, [s1, s2]] of setup) {
    root.querySelector<HTMLSelectElement>(`#rank-ballot-1-${side}`)!.value = String(rank);
    const i1 = root.querySelector<HTMLInputElement>(`#score-ballot-1-${side}-1`)!;
    const i2 = root.querySelector<HTMLInputElement>(`#score-ballot-1-${side}-2`)!;
    i1.value = String(s1);
    i1.dispatchEvent(new Event("input"));
    i2.value = String(s2);
    i2.dispatchEvent(new Event("input"));
  }
}

describe("QR fallback, fragments, QUOTA_EXHAUSTED, deadline lock, and QR-only mode", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it("shows signed QR on QUOTA_EXHAUSTED and decodes cleanly with core decodeQrBallot", async () => {
    const fixture = await createRoundFixture({ mode: "online", forms: ["ballot-1"] });
    const outbox = new OutboxManager();
    const fetchMock = createCdnFetchMock(fixture, async (url) => {
      if (url.endsWith("/v1/submit")) {
        return new Response(
          JSON.stringify({
            code: "QUOTA_EXHAUSTED",
            message: "Tournament daily share has been exhausted",
            retryAfterSeconds: 3600,
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ schema: 1, items: [] }), { status: 200 });
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

    fillValidBpBallot(root);
    const form = root.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    await vi.waitFor(() => {
      expect(root.textContent).toContain("quota is exhausted");
      expect(root.querySelector(".qr-svg")).not.toBeNull();
    });
    const textCode = root.querySelector<HTMLTextAreaElement>("#fallback-text-code")!.value;
    expect(textCode.startsWith("ST1.")).toBe(true);

    const decoded = await decodeQrBallot(textCode.split("\n"), fixture.keys.qrKey);
    expect(decoded.slug).toBe(fixture.link.slug);
    expect(decoded.type).toBe("ballot");

    handle.destroy();
    await outbox.close();
  });

  it("shows multi-fragment QR codes one at a time with 1 of 2 / 2 of 2 pagination and decodes via decodeQrBallot", async () => {
    const fixture = await createRoundFixture();
    const { t } = createI18n("en");

    // Deterministic incompressible payload so deflateRaw+base64url exceeds 1,800 chars and splits into ST1F fragments.
    let state = 0x12345678;
    const filler = Array.from({ length: 2800 }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(33 + (state % 90));
    }).join("");
    const codes = await encodeQrBallot(fixture.keys.qrKey, {
      sid: "01JABCDEFGHJKMNPQRSTVWXYZ1",
      slug: fixture.link.slug,
      lid: fixture.link.lookupId,
      rnd: "round-1",
      type: "ballot",
      payload: { filler },
    });
    expect(codes.length).toBeGreaterThanOrEqual(2);

    const panel = renderFallbackPanel({ codes, reason: "manual", t });
    document.getElementById("app")!.append(panel);

    expect(panel.querySelector(".qr-counter")?.textContent).toBe(`1 of ${codes.length}`);
    const nextBtn = Array.from(panel.querySelectorAll("button")).find(
      (b) => b.textContent === "Next code",
    )!;
    nextBtn.click();
    expect(panel.querySelector(".qr-counter")?.textContent).toBe(`2 of ${codes.length}`);

    const textBox = panel.querySelector<HTMLTextAreaElement>("#fallback-text-code")!;
    const decoded = await decodeQrBallot(textBox.value.split("\n"), fixture.keys.qrKey);
    expect(decoded.sid).toBe("01JABCDEFGHJKMNPQRSTVWXYZ1");
  });

  it("locks ballot form after deadline and renders signed QR with Give this to the Tab director", async () => {
    const deadlineIso = "2026-11-24T14:00:00.000Z";
    const fixture = await createRoundFixture({
      ballotDeadline: deadlineIso,
      timeZone: "Asia/Dhaka",
      forms: ["ballot-1"],
    });
    const outbox = new OutboxManager({ now: () => Date.parse(deadlineIso) + 60_000 });
    const unsent = await outbox.enqueue({
      slug: fixture.link.slug,
      roundId: "round-1",
      lookupId: fixture.link.lookupId,
      formId: "ballot-1",
      type: "ballot",
      payload: { ranks: { OG: 1, OO: 2, CG: 3, CO: 4 } },
    });

    const root = document.getElementById("app")!;
    const handle = await bootApp({
      root,
      locationHref: fixture.link.url,
      apiOrigin: "https://ballots.simpletab.org",
      fetchImpl: createCdnFetchMock(fixture, async () =>
        new Response(JSON.stringify({ schema: 1, items: [] }), { status: 200 }),
      ),
      now: () => Date.parse(deadlineIso) + 60_000,
      outbox,
      registerServiceWorker: false,
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(root.textContent).toContain("Give this to the Tab director");
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    const codeText = root.querySelector<HTMLTextAreaElement>("#fallback-text-code")!.value;
    const decoded = await decodeQrBallot(codeText.split("\n"), fixture.keys.qrKey);
    expect(decoded.sid).toBe(unsent.submissionId);

    handle.destroy();
    await outbox.close();
  });

  it("qr_only mode shows Show ballot QR, decodes with core decodeQrBallot, and never calls fetch for /v1/submit or /v1/status", async () => {
    const fixture = await createRoundFixture({ mode: "qr_only", forms: ["ballot-1"] });
    const outbox = new OutboxManager();
    const baseFetch = createCdnFetchMock(fixture);
    const fetchSpy = vi.fn(baseFetch);

    const root = document.getElementById("app")!;
    const handle = await bootApp({
      root,
      locationHref: fixture.link.url,
      apiOrigin: "https://ballots.simpletab.org",
      fetchImpl: fetchSpy as unknown as typeof fetch,
      outbox,
      registerServiceWorker: false,
    });

    const submitBtn = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submitBtn.textContent).toBe("Show ballot QR");

    fillValidBpBallot(root);
    submitBtn.form!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/v1/submit"))).toBe(false);
    expect(calledUrls.some((u) => u.includes("/v1/status"))).toBe(false);

    const codeText = root.querySelector<HTMLTextAreaElement>("#fallback-text-code")!.value;
    const decoded = await decodeQrBallot(codeText.split("\n"), fixture.keys.qrKey);
    expect(decoded.type).toBe("ballot");

    handle.destroy();
    await outbox.close();
  });

  it("online_and_qr mode provides Show QR instead without calling /v1/submit", async () => {
    const fixture = await createRoundFixture({ mode: "online_and_qr", forms: ["ballot-1"] });
    const outbox = new OutboxManager();
    const baseFetch = createCdnFetchMock(fixture, async () =>
      new Response(JSON.stringify({ schema: 1, items: [] }), { status: 200 }),
    );
    const fetchSpy = vi.fn(baseFetch);

    const root = document.getElementById("app")!;
    const handle = await bootApp({
      root,
      locationHref: fixture.link.url,
      apiOrigin: "https://ballots.simpletab.org",
      fetchImpl: fetchSpy as unknown as typeof fetch,
      outbox,
      registerServiceWorker: false,
    });

    const qrInsteadBtn = Array.from(root.querySelectorAll("button")).find(
      (b) => b.textContent === "Show QR instead",
    )!;
    expect(qrInsteadBtn).toBeDefined();

    fillValidBpBallot(root);
    qrInsteadBtn.click();
    await new Promise((r) => setTimeout(r, 50));

    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/v1/submit"))).toBe(false);
    expect(root.querySelector("#fallback-text-code")).not.toBeNull();

    handle.destroy();
    await outbox.close();
  });
});
