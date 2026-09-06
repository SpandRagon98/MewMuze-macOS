/**
 * Licence + trial state.
 *
 * The signature check itself happens in Rust (`verify_license`) against an
 * embedded public key — fully offline, so the app still never phones home and
 * a licence keeps working forever.
 *
 * Free tier keeps the whole charming pet: the cat, its physics, window
 * climbing, dragging and petting. The paid tier unlocks personalisation and
 * the productivity suite. That split means the free version is genuinely
 * pleasant (good word of mouth) while the things people specifically ask for
 * are what they pay for.
 */

export const TRIAL_DAYS = 14;

export interface LicenseState {
  /** A verified licence key is present. */
  licensed: boolean;
  /** Buyer name embedded in the key (display only). */
  name: string;
  /** Still inside the free trial window. */
  trialActive: boolean;
  /** Whole days left in the trial (0 once expired). */
  trialDaysLeft: number;
  /** licensed || trialActive — i.e. premium features are available. */
  premium: boolean;
  /** Existing locally signed key or a Dodo activation. */
  source: "legacy" | "dodo" | "";
  /** True only while a Dodo licence is using its 30-day offline allowance. */
  offlineGrace: boolean;
  /** Last known active-device count; omitted when Dodo has not exposed it yet. */
  devicesUsed?: number;
  /** Maximum active devices configured for this lifetime licence. */
  deviceLimit: number;
  /** Last protected activation state restored from the OS credential vault. */
  activationStatus: string;
}

/** Features reserved for buyers (available to everyone during the trial). */
export type PremiumFeature =
  | "breeds"
  | "costumes"
  | "appearance"
  | "productivity"
  | "context";

export const PREMIUM_FEATURES: Record<PremiumFeature, string> = {
  breeds: "Extra cat breeds",
  costumes: "Costumes & accessories",
  appearance: "Fur, eye and pattern customisation",
  productivity: "Pomodoro, reminders and work-rest",
  context: "App-aware reactions",
};

/**
 * Resolve licence/trial state. `firstRunUnix` is stored locally on first
 * launch; `nowUnix` is injected so this stays pure and testable.
 */
export function resolveLicenseState(
  opts: {
    licensed: boolean;
    name?: string;
    firstRunUnix: number;
    nowUnix: number;
    source?: LicenseState["source"];
    offlineGrace?: boolean;
    devicesUsed?: number;
    deviceLimit?: number;
    activationStatus?: string;
    /**
     * The trial anchor came from the credential vault, so its start date and
     * the clock it is judged against are both trustworthy. When false (the
     * vault was unavailable) the older, more forgiving settings-only rules
     * apply — a broken vault must never cost someone their trial.
     */
    trustedAnchor?: boolean;
  },
): LicenseState {
  const { licensed, firstRunUnix, nowUnix } = opts;
  const elapsedDays = Math.floor((nowUnix - firstRunUnix) / 86400);
  // Guard against a clock that has moved backwards (or a tampered first-run
  // stamp in the future): treat it as day zero rather than an endless trial.
  const used = Number.isFinite(elapsedDays) && elapsedDays > 0 ? elapsedDays : 0;
  // With a trusted anchor, a start date in the future cannot happen honestly —
  // the backend's watermark only ever moves forwards — so it means the stamp
  // was tampered with. Clamping to "day zero" there is what handed out a fresh
  // 14 days, so a trusted future start is treated as spent instead.
  const tampered = opts.trustedAnchor === true && firstRunUnix > nowUnix;
  const daysLeft = tampered ? 0 : Math.max(0, TRIAL_DAYS - used);
  const trialActive = !licensed && daysLeft > 0;
  return {
    licensed,
    name: opts.name ?? "",
    trialActive,
    trialDaysLeft: licensed ? 0 : daysLeft,
    premium: licensed || trialActive,
    source: opts.source ?? "",
    offlineGrace: opts.offlineGrace ?? false,
    devicesUsed: opts.devicesUsed,
    deviceLimit: opts.deviceLimit ?? 3,
    activationStatus: opts.activationStatus ?? (licensed ? "active" : ""),
  };
}

/** Whether a given premium feature may be used right now. */
export function canUse(state: LicenseState, _feature: PremiumFeature): boolean {
  return state.premium;
}

/** Short status line for the settings panel / tray tooltip. */
export function licenseSummary(state: LicenseState): string {
  if (state.licensed) {
    // MewMuze is a one-time purchase, so say so: "Licensed" alone left buyers
    // wondering whether it expires like the trial they just came from.
    const owner = state.name
      ? `Activated for lifetime — licensed to ${state.name}`
      : "Activated for lifetime";
    return state.offlineGrace
      ? `${owner} — offline grace active`
      : `${owner} — thank you!`;
  }
  if (state.trialActive) {
    return state.trialDaysLeft === 1
      ? "Trial: last day of full features"
      : `Trial: ${state.trialDaysLeft} days of full features left`;
  }
  return "Free version — unlock to restore full features";
}
