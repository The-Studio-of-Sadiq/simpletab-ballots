import type { RoundBundleRow } from "@simpletab/core/bundle";
import type { DerivedKeys, ParsedLink } from "@simpletab/core/crypto";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import { createLiveAnnouncer, setFieldValidity, type LiveAnnouncer } from "./a11y";
import {
  loadForms,
  loadManifest,
  loadMotions,
  openParticipantRound,
  parseParticipantUrl,
} from "./bundle";
import { mountDeadlineBanner, type DeadlineController } from "./deadline";
import {
  encodeFallbackCodes,
  renderFallbackPanel,
  type FallbackReason,
} from "./fallback";
import { renderBallotForm, type BallotDraftData, type BallotFormHandle } from "./forms/ballot";
import { renderCheckInForm } from "./forms/checkin";
import { renderFeedbackForm, type FeedbackDraftData, type FeedbackFormHandle } from "./forms/feedback";
import {
  SUPPORTED_LOCALES,
  createI18n,
  type I18nInstance,
  type TranslateFn,
} from "./i18n";
import {
  getCurrentRound,
  type FormsFile,
  type MotionItem,
  type RoundManifestEntry,
  type TournamentManifest,
} from "./manifest";
import {
  OutboxManager,
  statusTextForState,
  type OutboxRecord,
} from "./outbox";
import { generateUlid } from "./ulid";

export interface BootAppOptions {
  root?: HTMLElement;
  locationHref?: string;
  apiOrigin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  outbox?: OutboxManager;
  registerServiceWorker?: boolean;
  locale?: string;
}

export interface AppHandle {
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderShell(
  root: HTMLElement,
  i18n: I18nInstance,
  onLocaleChange: (locale: string) => void,
): {
  main: HTMLElement;
  onlinePill: HTMLElement;
  offlineBanner: HTMLElement;
  announcer: LiveAnnouncer;
} {
  root.replaceChildren();
  const { t } = i18n;
  document.documentElement.lang = i18n.getLocale();

  const skip = el("a", "skip-link", t("app.skipToMain"));
  skip.href = "#main-content";

  const header = el("header", "app-header");
  const headerInner = el("div", "app-header-inner");

  const title = el("h1", "app-title", t("app.title"));

  const controls = el("div", "header-controls");
  const isOnline = typeof navigator === "undefined" || navigator.onLine !== false;
  const onlinePill = el(
    "span",
    isOnline ? "status-pill status-online" : "status-pill status-offline",
    isOnline ? t("app.onlineStatus") : t("app.offlineStatus"),
  );

  const langWrap = el("div", "lang-picker");
  const langLabel = el("label", "visually-hidden", t("app.languageLabel"));
  langLabel.htmlFor = "app-locale-select";
  const langSelect = el("select");
  langSelect.id = "app-locale-select";
  langSelect.name = "locale";
  for (const code of SUPPORTED_LOCALES) {
    const opt = el("option", undefined, code.toUpperCase());
    opt.value = code;
    langSelect.append(opt);
  }
  langSelect.value = i18n.getLocale();
  langSelect.addEventListener("change", () => {
    onLocaleChange(langSelect.value);
  });
  langWrap.append(langLabel, langSelect);

  controls.append(onlinePill, langWrap);
  headerInner.append(title, controls);
  header.append(headerInner);

  const offlineBanner = el("div", "offline-banner", t("app.offlineBanner"));
  offlineBanner.setAttribute("role", "status");
  offlineBanner.hidden = isOnline;

  const main = el("main", "app-main");
  main.id = "main-content";
  main.tabIndex = -1;

  const footer = el("footer", "app-footer");
  footer.append(el("p", undefined, t("app.footerNote")));

  const announcer = createLiveAnnouncer(root);
  root.append(skip, header, offlineBanner, main, footer);

  return { main, onlinePill, offlineBanner, announcer };
}

function renderMessageCard(
  main: HTMLElement,
  headingText: string,
  bodyText: string,
  detailText?: string,
): void {
  const card = el("section", "card error-card");
  card.setAttribute("role", "alert");
  const h2 = el("h2", undefined, headingText);
  const p = el("p", undefined, bodyText);
  card.append(h2, p);
  if (detailText) {
    card.append(el("p", "hint", detailText));
  }
  main.replaceChildren(card);
}

function renderPasscodePrompt(
  main: HTMLElement,
  t: TranslateFn,
  showError: boolean,
  onSubmit: (passcode: string) => Promise<void>,
): void {
  const card = el("section", "card form-card");
  card.setAttribute("aria-labelledby", "passcode-heading");
  const h2 = el("h2", undefined, t("passcode.title"));
  h2.id = "passcode-heading";
  const prompt = el("p", undefined, t("passcode.prompt"));

  const form = el("form");
  form.noValidate = true;

  const field = el("div", "field");
  const label = el("label", undefined, t("passcode.label"));
  label.htmlFor = "passcode-input";

  const inputRow = el("div", "password-row");
  const input = el("input");
  input.type = "password";
  input.id = "passcode-input";
  input.name = "passcode";
  input.autocomplete = "current-password";
  input.required = true;
  input.setAttribute("aria-invalid", "false");

  const toggleBtn = el("button", "btn btn-secondary", t("passcode.show"));
  toggleBtn.type = "button";
  toggleBtn.setAttribute("aria-pressed", "false");
  toggleBtn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    toggleBtn.setAttribute("aria-pressed", showing ? "false" : "true");
    toggleBtn.textContent = showing ? t("passcode.show") : t("passcode.hide");
  });
  inputRow.append(input, toggleBtn);

  const errEl = el("p", "field-error");
  errEl.id = "passcode-error";
  errEl.hidden = true;
  if (showError) {
    setFieldValidity(input, errEl, t("passcode.wrong"));
  }

  input.addEventListener("input", () => {
    setFieldValidity(input, errEl, "");
  });

  field.append(label, inputRow, errEl);

  const actions = el("div", "actions-row");
  const submitBtn = el("button", "btn btn-primary", t("passcode.submit"));
  submitBtn.type = "submit";
  actions.append(submitBtn);

  form.append(field, actions);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      await onSubmit(input.value);
    } finally {
      submitBtn.disabled = false;
    }
  });

  card.append(h2, prompt, form);
  main.replaceChildren(card);
  input.focus();
}

function renderAssignmentSummary(
  manifest: TournamentManifest,
  round: RoundManifestEntry,
  row: RoundBundleRow,
  formsFile: FormsFile,
  motions: readonly MotionItem[],
  t: TranslateFn,
): HTMLElement {
  const card = el("section", "card summary-card");
  card.setAttribute("aria-labelledby", "summary-heading");

  const h2 = el("h2", undefined, t("round.summaryHeading"));
  h2.id = "summary-heading";
  card.append(h2);

  const dl = el("dl", "summary-list");
  const addItem = (term: string, val: string): void => {
    const dt = el("dt", undefined, term);
    const dd = el("dd", undefined, val);
    dl.append(dt, dd);
  };

  addItem(t("round.tournament"), manifest.tournamentName);
  addItem(t("round.round"), round.roundName);
  addItem(t("round.room"), row.room);
  if (row.venue && row.venue !== row.room) {
    addItem(t("round.venue"), row.venue);
  }
  if (row.side) {
    addItem(t("round.side"), sideLabel(row.side, formsFile.preferences, "full"));
  }
  if (row.teammates && row.teammates.length > 0) {
    addItem(t("round.teammates"), row.teammates.join(", "));
  }
  if (row.panel && row.panel.length > 0) {
    addItem(
      t("round.panel"),
      row.panel.map((m) => `${m.name} (${m.role})`).join(", "),
    );
  }
  card.append(dl);

  const motionBox = el("div", "motion-box");
  motionBox.append(el("h3", undefined, t("round.motionHeading")));
  if (motions.length === 0) {
    motionBox.append(el("p", "hint", t("round.motionPending")));
  } else {
    for (const m of motions) {
      motionBox.append(el("p", "motion-text", m.text));
      if (m.infoSlide) {
        motionBox.append(
          el("p", "hint", `${t("round.infoSlide")}: ${m.infoSlide}`),
        );
      }
    }
  }
  card.append(motionBox);
  return card;
}

export async function bootApp(options: BootAppOptions = {}): Promise<AppHandle> {
  const root = options.root ?? document.getElementById("app");
  if (!root) {
    throw new Error("App root element #app not found.");
  }

  const locationHref = options.locationHref ?? window.location.href;
  const apiOrigin = options.apiOrigin ?? window.location.origin;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const outbox = options.outbox ?? new OutboxManager({ now });

  if (
    options.registerServiceWorker !== false &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator
  ) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  let activeLocale =
    options.locale ??
    (typeof navigator !== "undefined" ? navigator.language : "en");
  let i18n = createI18n(activeLocale);

  let deadlineController: DeadlineController | null = null;
  let destroyed = false;

  const cleanupFns: Array<() => void> = [];
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    deadlineController?.destroy();
    for (const fn of cleanupFns) fn();
    cleanupFns.length = 0;
  }

  async function run(): Promise<void> {
    deadlineController?.destroy();
    deadlineController = null;

    i18n = createI18n(activeLocale);
    const { t } = i18n;
    const shell = renderShell(root!, i18n, (nextLocale) => {
      activeLocale = nextLocale;
      void run();
    });

    shell.main.replaceChildren(el("p", "hint", t("app.loading")));

    const parsedLink = parseParticipantUrl(locationHref);
    if (!parsedLink.ok) {
      renderMessageCard(
        shell.main,
        t("error.invalidLinkTitle"),
        t("error.invalidLinkBody"),
        parsedLink.error.message,
      );
      return;
    }
    const link: ParsedLink = parsedLink.value;

    let manifest: TournamentManifest;
    try {
      manifest = await loadManifest(link.cdnHost, fetchImpl);
    } catch (err) {
      renderMessageCard(
        shell.main,
        t("error.loadFailedTitle"),
        t("error.generic", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    if (!options.locale && manifest.defaultLanguage && activeLocale === navigator.language) {
      i18n.setLocale(manifest.defaultLanguage);
      document.documentElement.lang = i18n.getLocale();
    }

    const round = getCurrentRound(manifest);
    if (!round) {
      renderMessageCard(shell.main, t("error.loadFailedTitle"), t("error.noRound"));
      return;
    }

    async function unlockAndRender(passcode?: string): Promise<void> {
      const opened = await openParticipantRound({
        link,
        round: round!,
        passcode,
        fetchImpl,
      });
      if (opened.status === "bucket_missing") {
        renderMessageCard(shell.main, t("error.loadFailedTitle"), t("error.bucketMissing"));
        return;
      }
      if (opened.status === "passcode_required") {
        if (manifest.usesPasscodes === false) {
          renderMessageCard(shell.main, t("error.loadFailedTitle"), t("error.rowNotFound"));
          return;
        }
        renderPasscodePrompt(
          shell.main,
          t,
          passcode !== undefined,
          async (entered) => {
            await unlockAndRender(entered);
          },
        );
        return;
      }

      await renderUnlockedRound(
        shell,
        i18n,
        link,
        manifest,
        round!,
        opened.keys,
        opened.row,
      );
    }

    await unlockAndRender(undefined);
  }

  async function renderUnlockedRound(
    shell: {
      main: HTMLElement;
      onlinePill: HTMLElement;
      offlineBanner: HTMLElement;
      announcer: LiveAnnouncer;
    },
    activeI18n: I18nInstance,
    link: ParsedLink,
    manifest: TournamentManifest,
    round: RoundManifestEntry,
    keys: DerivedKeys,
    row: RoundBundleRow,
  ): Promise<void> {
    const { t } = activeI18n;
    const mode = manifest.ballotCollectionMode;

    let formsFile: FormsFile;
    try {
      formsFile = await loadForms(link.cdnHost, round.formsFile, fetchImpl);
    } catch (err) {
      renderMessageCard(
        shell.main,
        t("error.loadFailedTitle"),
        t("error.generic", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    let motions: MotionItem[] = [];
    if (round.motionsFile) {
      try {
        const motionsFile = await loadMotions(link.cdnHost, round.motionsFile, fetchImpl);
        motions = motionsFile.motions;
      } catch {
        motions = [];
      }
    }

    shell.main.replaceChildren();

    const fallbackSlot = el("div", "fallback-slot");
    const ballotHandles: BallotFormHandle[] = [];
    const feedbackHandles: FeedbackFormHandle[] = [];

    let cachedRecords: OutboxRecord[] = await outbox.listByScope(link.slug, link.lookupId);

    async function showQrForEnvelope(
      type: "ballot" | "feedback" | "checkin",
      payload: Record<string, unknown>,
      reason: FallbackReason,
      sid?: string,
    ): Promise<void> {
      const codes = await encodeFallbackCodes(keys.qrKey, {
        sid: sid ?? generateUlid(now()),
        slug: link.slug,
        lid: link.lookupId,
        rnd: round.roundId,
        type,
        payload,
      });
      const panel = renderFallbackPanel({
        codes,
        reason,
        t,
        onClose: () => {
          fallbackSlot.replaceChildren();
        },
      });
      fallbackSlot.replaceChildren(panel);
      const heading = panel.querySelector<HTMLElement>("#fallback-heading");
      heading?.focus();
    }

    // Outbox status card.
    const outboxSection = el("section", "card outbox-card");
    outboxSection.setAttribute("aria-labelledby", "outbox-heading");
    const outboxHeader = el("div", "outbox-header");
    const outboxHeading = el("h2", undefined, t("outbox.heading"));
    outboxHeading.id = "outbox-heading";
    outboxHeader.append(outboxHeading);

    let refreshBtn: HTMLButtonElement | null = null;
    if (mode !== "qr_only") {
      refreshBtn = el("button", "btn btn-secondary", t("outbox.refresh"));
      refreshBtn.type = "button";
      outboxHeader.append(refreshBtn);
    }

    const outboxList = el("ul", "outbox-list");
    const outboxEmpty = el("p", "hint", t("outbox.empty"));
    outboxSection.append(outboxHeader, outboxEmpty, outboxList);

    function renderOutboxRecords(records: OutboxRecord[]): void {
      cachedRecords = records.filter((r) => r.roundId === round.roundId);
      outboxList.replaceChildren();
      outboxEmpty.hidden = cachedRecords.length > 0;
      outboxList.hidden = cachedRecords.length === 0;

      for (const rec of cachedRecords) {
        const li = el("li", `outbox-item outbox-state-${rec.state}`);
        const textWrap = el("div", "outbox-item-info");
        const typeLabel = t(`outbox.type.${rec.type}`);
        const titleEl = el("strong", undefined, typeLabel);
        const stateText = el("span", "outbox-status-text", statusTextForState(rec.state, t));
        textWrap.append(titleEl, stateText);
        if (rec.lastErrorMessage && rec.state === "local_only") {
          textWrap.append(el("span", "hint", rec.lastErrorMessage));
        }
        li.append(textWrap);

        if (rec.state === "local_only") {
          const qrBtn = el("button", "btn btn-secondary", t("outbox.showQr"));
          qrBtn.type = "button";
          qrBtn.addEventListener("click", () => {
            void showQrForEnvelope(
              rec.type,
              rec.payload,
              deadlineController?.isLocked() ? "deadline" : "manual",
              rec.submissionId,
            );
          });
          li.append(qrBtn);
        }

        outboxList.append(li);
      }

      deadlineController?.update();
    }

    async function refreshAllStatus(): Promise<void> {
      if (mode === "qr_only") return;
      if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = t("outbox.refreshing");
      }
      try {
        await outbox.retryPending({
          slug: link.slug,
          lookupId: link.lookupId,
          keys,
          apiOrigin,
          mode,
          fetchImpl,
        });
        const updated = await outbox.refreshStatus({
          slug: link.slug,
          lookupId: link.lookupId,
          apiOrigin,
          mode,
          fetchImpl,
        });
        renderOutboxRecords(updated);
      } finally {
        if (refreshBtn) {
          refreshBtn.disabled = false;
          refreshBtn.textContent = t("outbox.refresh");
        }
      }
    }

    refreshBtn?.addEventListener("click", () => {
      void refreshAllStatus();
    });

    // Deadline banner.
    deadlineController = mountDeadlineBanner({
      deadlineIso: round.ballotDeadline,
      timeZone: manifest.timeZone,
      roundName: round.roundName,
      mode,
      locale: activeI18n.getLocale(),
      now,
      hasUnsentBallot: () =>
        cachedRecords.some((r) => r.type === "ballot" && r.state === "local_only"),
      t,
      onLockChange: (locked) => {
        for (const h of ballotHandles) {
          h.setLocked(locked);
        }
        if (locked) {
          const unsentBallot = cachedRecords.find(
            (r) => r.type === "ballot" && r.state === "local_only",
          );
          if (unsentBallot) {
            void showQrForEnvelope(
              "ballot",
              unsentBallot.payload,
              "deadline",
              unsentBallot.submissionId,
            );
          } else {
            for (const h of ballotHandles) {
              const payload = h.getPayload();
              if (payload) {
                void showQrForEnvelope("ballot", payload, "deadline");
                break;
              }
            }
          }
        }
      },
    });

    const summaryCard = renderAssignmentSummary(
      manifest,
      round,
      row,
      formsFile,
      motions,
      t,
    );

    shell.main.append(
      deadlineController.element,
      summaryCard,
      fallbackSlot,
      outboxSection,
    );

    const formsContainer = el("div", "forms-stack");
    if (row.forms.length === 0) {
      formsContainer.append(el("p", "hint", t("round.noForms")));
    }

    async function handleOnlineSubmit(
      formId: string,
      type: "ballot" | "feedback" | "checkin",
      payload: Record<string, unknown>,
    ): Promise<void> {
      const rec = await outbox.enqueue({
        slug: link.slug,
        roundId: round.roundId,
        lookupId: link.lookupId,
        formId,
        type,
        payload,
      });
      await outbox.clearDraft(link.slug, round.roundId, link.lookupId, formId);
      renderOutboxRecords(await outbox.listByScope(link.slug, link.lookupId));

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await showQrForEnvelope(type, payload, "offline", rec.submissionId);
        return;
      }

      const result = await outbox.sendSubmission(
        rec.submissionId,
        keys,
        apiOrigin,
        mode,
        fetchImpl,
      );
      renderOutboxRecords(await outbox.listByScope(link.slug, link.lookupId));

      if (result.outcome === "quota_exhausted") {
        await showQrForEnvelope(type, payload, "quota", rec.submissionId);
      } else if (result.outcome === "deadline_passed") {
        if (type === "ballot") {
          for (const h of ballotHandles) h.setLocked(true);
        }
        await showQrForEnvelope(type, payload, "deadline", rec.submissionId);
      } else if (result.outcome === "retry_later") {
        await showQrForEnvelope(type, payload, "offline", rec.submissionId);
      } else if (result.outcome === "rejected") {
        shell.announcer.announceAssertive(result.message);
      }
    }

    const initialBallotLocked = deadlineController.isLocked();
    const feedbackLocked =
      mode !== "qr_only" &&
      round.feedbackDeadline !== undefined &&
      now() >= Date.parse(round.feedbackDeadline);

    for (const formId of row.forms) {
      const def = formsFile.forms[formId];
      if (!def) continue;

      if (def.kind === "ballot") {
        const draft = await outbox.loadDraft<BallotDraftData>(
          link.slug,
          round.roundId,
          link.lookupId,
          formId,
        );
        const handle = renderBallotForm({
          def,
          formsFile,
          row,
          motions,
          mode,
          initialDraft: draft,
          locked: initialBallotLocked,
          t,
          announcer: shell.announcer,
          onDraftChange: (d) => {
            void outbox.saveDraft(link.slug, round.roundId, link.lookupId, formId, d);
          },
          onSubmitOnline: (payload) => handleOnlineSubmit(formId, "ballot", payload),
          onShowQr: (payload) =>
            showQrForEnvelope(
              "ballot",
              payload,
              mode === "qr_only" ? "qr_only" : "manual",
            ),
        });
        ballotHandles.push(handle);
        formsContainer.append(handle.element);
      } else if (def.kind === "feedback") {
        const draft = await outbox.loadDraft<FeedbackDraftData>(
          link.slug,
          round.roundId,
          link.lookupId,
          formId,
        );
        const handle = renderFeedbackForm({
          def,
          preferences: formsFile.preferences,
          row,
          mode,
          initialDraft: draft,
          locked: feedbackLocked,
          t,
          announcer: shell.announcer,
          onDraftChange: (d) => {
            void outbox.saveDraft(link.slug, round.roundId, link.lookupId, formId, d);
          },
          onSubmitOnline: (payload) => handleOnlineSubmit(formId, "feedback", payload),
          onShowQr: (payload) =>
            showQrForEnvelope(
              "feedback",
              payload,
              mode === "qr_only" ? "qr_only" : "manual",
            ),
        });
        feedbackHandles.push(handle);
        formsContainer.append(handle.element);
      } else if (def.kind === "checkin") {
        const checkinCard = renderCheckInForm({
          def,
          mode,
          t,
          onSubmitOnline: (payload) => handleOnlineSubmit(formId, "checkin", payload),
          onShowQr: (payload) =>
            showQrForEnvelope(
              "checkin",
              payload,
              mode === "qr_only" ? "qr_only" : "manual",
            ),
        });
        formsContainer.append(checkinCard);
      }
    }

    shell.main.append(formsContainer);
    renderOutboxRecords(cachedRecords);

    // If the deadline already passed and an unsent ballot is waiting, show its QR immediately.
    if (initialBallotLocked) {
      const unsent = cachedRecords.find(
        (r) => r.type === "ballot" && r.state === "local_only",
      );
      if (unsent) {
        await showQrForEnvelope("ballot", unsent.payload, "deadline", unsent.submissionId);
      }
    }

    const onOnline = (): void => {
      shell.offlineBanner.hidden = true;
      shell.onlinePill.className = "status-pill status-online";
      shell.onlinePill.textContent = t("app.onlineStatus");
      void refreshAllStatus();
    };
    const onOffline = (): void => {
      shell.offlineBanner.hidden = false;
      shell.onlinePill.className = "status-pill status-offline";
      shell.onlinePill.textContent = t("app.offlineStatus");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    cleanupFns.push(() => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    });

    if (mode !== "qr_only" && (typeof navigator === "undefined" || navigator.onLine !== false)) {
      await refreshAllStatus();
    }
  }

  await run();
  return { destroy };
}

if (typeof document !== "undefined" && document.getElementById("app")) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void bootApp();
    });
  } else {
    void bootApp();
  }
}
