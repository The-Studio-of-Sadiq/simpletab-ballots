import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveAnnouncer } from "../src/a11y";
import { renderBallotForm } from "../src/forms/ballot";
import { renderCheckInForm } from "../src/forms/checkin";
import { renderFeedbackForm } from "../src/forms/feedback";
import { createI18n } from "../src/i18n";
import type { BallotFormDefinition, CheckInFormDefinition, FeedbackFormDefinition } from "../src/manifest";
import { createRoundFixture } from "./fixtures";

describe("accessible forms and core validation", () => {
  const { t } = createI18n("en");
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="mount"></div>';
    container = document.getElementById("mount")!;
  });

  it("renders BP consensus ballot, blocks invalid scores/ranks with text errors, and submits valid ballot", async () => {
    const fixture = await createRoundFixture({ format: "bp" });
    const def = fixture.formsFile.forms["ballot-1"] as BallotFormDefinition;
    const announcer = createLiveAnnouncer(container);
    const onSubmitOnline = vi.fn(async (_payload: Record<string, unknown>) => {});
    const onShowQr = vi.fn(async (_payload: Record<string, unknown>) => {});

    const handle = renderBallotForm({
      def,
      formsFile: fixture.formsFile,
      row: fixture.row,
      motions: [],
      mode: "online",
      t,
      announcer,
      onSubmitOnline,
      onShowQr,
    });
    container.append(handle.element);

    const form = handle.element.querySelector("form")!;

    // Verify all 4 BP sides rendered with labels on every input/select.
    for (const side of ["OG", "OO", "CG", "CO"]) {
      expect(form.querySelector(`#rank-ballot-1-${side}`)).not.toBeNull();
    }
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
      expect(form.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
    }

    // Enter out-of-range score and duplicate rank -> blocked with text error.
    const ogScore1 = form.querySelector<HTMLInputElement>("#score-ballot-1-OG-1")!;
    ogScore1.value = "99";
    ogScore1.dispatchEvent(new Event("blur"));
    expect(ogScore1.getAttribute("aria-invalid")).toBe("true");
    expect(form.textContent).toContain("between 68 and 84");

    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onSubmitOnline).not.toHaveBeenCalled();
    expect(form.querySelector(".error-summary")?.hasAttribute("hidden")).toBe(false);

    // Fill valid BP ballot with distinct totals and matching ranks 1..4.
    const setup: Array<[string, number, [number, number]]> = [
      ["OG", 1, [80, 80]],
      ["OO", 2, [78, 78]],
      ["CG", 3, [76, 76]],
      ["CO", 4, [74, 74]],
    ];
    for (const [side, rank, [s1, s2]] of setup) {
      form.querySelector<HTMLSelectElement>(`#rank-ballot-1-${side}`)!.value = String(rank);
      const i1 = form.querySelector<HTMLInputElement>(`#score-ballot-1-${side}-1`)!;
      const i2 = form.querySelector<HTMLInputElement>(`#score-ballot-1-${side}-2`)!;
      i1.value = String(s1);
      i1.dispatchEvent(new Event("input"));
      i2.value = String(s2);
      i2.dispatchEvent(new Event("input"));
    }

    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    expect(onSubmitOnline).toHaveBeenCalledTimes(1);
    const payload = onSubmitOnline.mock.calls[0][0] as {
      ranks: Record<string, number>;
      teamScores: Record<string, { totalSpeakerScore: number }>;
    };
    expect(payload.ranks).toEqual({ OG: 1, OO: 2, CG: 3, CO: 4 });
    expect(payload.teamScores.OG.totalSpeakerScore).toBe(160);
  });

  it("renders two-team ballot with reply & iron-person rules and blocks invalid reply/duplicate speakers", async () => {
    const fixture = await createRoundFixture({ format: "australs" });
    const def = fixture.formsFile.forms["ballot-1"] as BallotFormDefinition;
    const announcer = createLiveAnnouncer(container);
    const onSubmitOnline = vi.fn(async (_payload: Record<string, unknown>) => {});

    const handle = renderBallotForm({
      def,
      formsFile: fixture.formsFile,
      row: fixture.row,
      motions: [],
      mode: "online",
      t,
      announcer,
      onSubmitOnline,
      onShowQr: async () => {},
    });
    container.append(handle.element);
    const form = handle.element.querySelector("form")!;

    // Fill AFF with duplicate speaker without ghost and invalid reply score -> must fail.
    form.querySelector<HTMLSelectElement>("#spk-ballot-1-AFF-1")!.value = "a1";
    form.querySelector<HTMLSelectElement>("#spk-ballot-1-AFF-2")!.value = "a1";
    form.querySelector<HTMLSelectElement>("#spk-ballot-1-AFF-3")!.value = "a3";
    form.querySelector<HTMLSelectElement>("#spk-ballot-1-AFF-4")!.value = "a3"; // last speaker cannot reply!

    form.querySelector<HTMLInputElement>("#score-ballot-1-AFF-1")!.value = "75";
    form.querySelector<HTMLInputElement>("#score-ballot-1-AFF-2")!.value = "75";
    form.querySelector<HTMLInputElement>("#score-ballot-1-AFF-3")!.value = "75";
    form.querySelector<HTMLInputElement>("#score-ballot-1-AFF-4")!.value = "50"; // invalid reply score

    form.querySelector<HTMLInputElement>("#score-ballot-1-NEG-1")!.value = "74";
    form.querySelector<HTMLInputElement>("#score-ballot-1-NEG-2")!.value = "74";
    form.querySelector<HTMLInputElement>("#score-ballot-1-NEG-3")!.value = "74";
    form.querySelector<HTMLInputElement>("#score-ballot-1-NEG-4")!.value = "37";

    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onSubmitOnline).not.toHaveBeenCalled();
    expect(form.textContent).toContain("iron-person");
    expect(form.textContent).toContain("Reply score (50) must be between 34 and 42");

    // Fix: mark position 2 as ghost (iron-person), reply speaker = a1, valid reply score = 38.5.
    form.querySelector<HTMLInputElement>("#ghost-ballot-1-AFF-2")!.checked = true;
    form.querySelector<HTMLSelectElement>("#spk-ballot-1-AFF-4")!.value = "a1";
    form.querySelector<HTMLInputElement>("#score-ballot-1-AFF-4")!.value = "38.5";

    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onSubmitOnline).toHaveBeenCalledTimes(1);
    const payload = onSubmitOnline.mock.calls[0][0] as {
      teamScores: Record<string, { win: boolean; totalSpeakerScore: number }>;
    };
    // AFF counted speeches: 75 + 75 + 38.5 = 188.5 (ghost excluded from team total by default)
    expect(payload.teamScores.AFF.totalSpeakerScore).toBe(188.5);
    // NEG: 74 + 74 + 74 + 37 = 259 -> NEG wins
    expect(payload.teamScores.NEG.win).toBe(true);
  });

  it("validates feedback questions and submits valid feedback and check-in", async () => {
    const fixture = await createRoundFixture();
    const fbDef = fixture.formsFile.forms["feedback-1"] as FeedbackFormDefinition;
    const ciDef = fixture.formsFile.forms["checkin-1"] as CheckInFormDefinition;
    const announcer = createLiveAnnouncer(container);
    const onFbSubmit = vi.fn(async () => {});
    const onCiSubmit = vi.fn(async () => {});

    const fbHandle = renderFeedbackForm({
      def: fbDef,
      preferences: fixture.formsFile.preferences,
      row: fixture.row,
      mode: "online",
      t,
      announcer,
      onSubmitOnline: onFbSubmit,
      onShowQr: async () => {},
    });
    const ciEl = renderCheckInForm({
      def: ciDef,
      mode: "online",
      t,
      onSubmitOnline: onCiSubmit,
      onShowQr: async () => {},
    });
    container.append(fbHandle.element, ciEl);

    const fbForm = fbHandle.element.querySelector("form")!;
    // Required integer_scale unanswered -> blocked.
    fbForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onFbSubmit).not.toHaveBeenCalled();
    expect(fbForm.textContent).toContain("Clarity");

    // Select scale value 4 and submit.
    fbForm.querySelector<HTMLInputElement>("#fb-q-feedback-1-q-scale-4")!.checked = true;
    fbForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onFbSubmit).toHaveBeenCalledTimes(1);

    const ciForm = ciEl.querySelector("form")!;
    ciForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onCiSubmit).toHaveBeenCalledWith({
      formId: "checkin-1",
      roundId: "round-1",
      available: true,
    });
  });
});
