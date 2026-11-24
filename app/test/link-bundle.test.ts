import { beforeEach, describe, expect, it } from "vitest";
import { bootApp, type AppHandle } from "../src/main";
import { OutboxManager } from "../src/outbox";
import { createCdnFetchMock, createRoundFixture } from "./fixtures";

describe("link parsing, key derivation, and round bundle opening", () => {
  let root: HTMLElement;
  let handle: AppHandle | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    handle = null;
  });

  it("opens a round sealed with core sealRound and renders room, side, teammates, panel, motion, and forms", async () => {
    const fixture = await createRoundFixture({
      format: "australs",
      includeMotion: true,
    });
    // Include side + teammates in a team-style row.
    const teamFixture = await createRoundFixture({
      format: "australs",
      includeMotion: true,
    });
    teamFixture.row.side = "AFF";
    teamFixture.row.teammates = ["Sam Speaker", "Pat Speaker"];

    // Re-seal with updated row fields using sealRound.
    const { sealRound } = await import("@simpletab/core/bundle");
    teamFixture.buckets = await sealRound({
      roundSeq: 1,
      roundId: "round-1",
      rows: [
        {
          lookupId: teamFixture.link.lookupId,
          keys: {
            fileKey: teamFixture.keys.fileKey,
            lookupKey: teamFixture.keys.lookupKey,
          },
          row: teamFixture.row,
        },
      ],
    });

    const outbox = new OutboxManager();
    const fetchMock = createCdnFetchMock(teamFixture, async (url) => {
      if (url.includes("/v1/status")) {
        return new Response(JSON.stringify({ schema: 1, items: [] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    handle = await bootApp({
      root,
      locationHref: teamFixture.link.url,
      apiOrigin: "https://ballots.simpletab.org",
      fetchImpl: fetchMock,
      outbox,
      registerServiceWorker: false,
    });

    const text = root.textContent ?? "";
    expect(text).toContain("WUDC 2027");
    expect(text).toContain("Room 101");
    expect(text).toContain("Main Hall");
    expect(text).toContain("Affirmative");
    expect(text).toContain("Sam Speaker, Pat Speaker");
    expect(text).toContain("Alice Chair (Chair), Bob Panel (Panellist)");
    expect(text).toContain("offline-first software beats cloud-first software");
    expect(root.querySelectorAll("form").length).toBe(3);

    handle.destroy();
    await outbox.close();
    expect(fixture.bucketIndex).toBeGreaterThanOrEqual(0);
  });

  it("asks for a passcode when decryption fails and usesPasscodes is true, rejects wrong passcode, and unlocks with right passcode", async () => {
    const fixture = await createRoundFixture({
      passcode: "secret-42",
      usesPasscodes: true,
      includeMotion: false,
    });
    const outbox = new OutboxManager();
    const fetchMock = createCdnFetchMock(fixture, async () =>
      new Response(JSON.stringify({ schema: 1, items: [] }), { status: 200 }),
    );

    handle = await bootApp({
      root,
      locationHref: fixture.link.url,
      apiOrigin: "https://ballots.simpletab.org",
      fetchImpl: fetchMock,
      outbox,
      registerServiceWorker: false,
    });

    const passInput = root.querySelector<HTMLInputElement>("#passcode-input");
    expect(passInput).not.toBeNull();
    expect(root.textContent).toContain("Passcode required");

    // Wrong passcode -> shows error text and keeps prompt open.
    passInput!.value = "wrong-pass";
    passInput!.form!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));

    expect(root.textContent).toContain("Incorrect passcode");
    expect(root.querySelector("#passcode-input")?.getAttribute("aria-invalid")).toBe("true");

    // Correct passcode -> decrypts row and shows assignment.
    const retryInput = root.querySelector<HTMLInputElement>("#passcode-input")!;
    retryInput.value = "secret-42";
    retryInput.form!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(root.textContent).toContain("Room 101");
    expect(root.textContent).toContain("Motion has not been released online yet");

    handle.destroy();
    await outbox.close();
  });

  it("shows a clear error on an invalid link", async () => {
    const outbox = new OutboxManager();
    handle = await bootApp({
      root,
      locationHref: "https://ballots.simpletab.org/t/wudc-2027#missing-fragment",
      apiOrigin: "https://ballots.simpletab.org",
      outbox,
      registerServiceWorker: false,
    });

    expect(root.textContent).toContain("Private link could not be opened");
    handle.destroy();
    await outbox.close();
  });
});
