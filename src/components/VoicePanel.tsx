import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placePanel, type Area, type Box } from "../quicktools/panelPlacement";
import type { VoiceState } from "../companion/voiceController";
import { Icon } from "./icons";

/**
 * The recorder: Start, Stop, "Transcribing locally…", then CLEAN and RAW.
 * The raw transcript is never removed; the recording itself is deleted when
 * the panel closes unless the user chose "Save recording".
 */
export const VOICE_PANEL_SIZE = { width: 320, height: 330 };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function VoicePanel({
  cat,
  area,
  voice,
  onStart,
  onStop,
  onCancel,
  onCopy,
  onSaveRecording,
  onNew,
  onClose,
}: {
  cat: Box;
  area: Area;
  voice: VoiceState;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onCopy: (text: string) => void;
  onSaveRecording: () => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"clean" | "raw">("clean");
  /** Which transcript was just copied, so the button can say so. A new recording clears it. */
  const [copied, setCopied] = useState<"clean" | "raw" | null>(null);
  useEffect(() => setCopied(null), [voice.raw]);
  const boxRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(() => placePanel({ cat, panel: VOICE_PANEL_SIZE, area }));
  // Each phase has a different height: re-place on every real size change.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) {
        const next = placePanel({ cat, panel: { width: r.width, height: r.height }, area });
        setPlacement((p) => (p.x === next.x && p.y === next.y ? p : next));
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cat, area]);

  const mine = voice.mode === "recorder" || voice.mode === null;
  const phase = mine ? voice.phase : "idle";

  return (
    <div
      ref={boxRef}
      className="quick-tools companion-panel voice-panel"
      style={{ left: placement.x, top: placement.y, width: VOICE_PANEL_SIZE.width }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="qt-head">
        <span className="qt-title">
          <Icon name="mic" size={18} /> Voice recorder
        </span>
        <span className="cp-local" title="Transcribed on this computer. Nothing is uploaded.">
          on this PC
        </span>
        <button className="qt-x" onClick={onClose} title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      {(phase === "idle" || phase === "starting") && (
        <div className="vp-center">
          <button className="vp-record" onClick={onStart} disabled={phase === "starting"}>
            <span className="cp-rec-dot" /> Start Recording
          </button>
          <p className="cp-note">The microphone is on only while recording. Audio never leaves this computer.</p>
        </div>
      )}

      {phase === "recording" && (
        <div className="vp-center">
          <div className="vp-live">
            <span className="cp-rec-dot live" /> Recording {clock(voice.seconds)}
          </div>
          <div className="vp-meter">
            <span style={{ width: `${Math.min(100, voice.level * 400)}%` }} />
          </div>
          <div className="vp-row">
            <button className="sk-btn primary" onClick={onStop}>
              Stop Recording
            </button>
            <button className="sk-btn" onClick={onCancel}>
              Discard
            </button>
          </div>
        </div>
      )}

      {phase === "transcribing" && (
        <div className="vp-center">
          <div className="vp-live">
            <span className="cp-rec-dot live" /> Writing down what you said…
          </div>
          <button className="sk-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {phase === "error" && (
        <div className="vp-center">
          <div className="cp-error">{voice.error}</div>
          <button className="sk-btn" onClick={onNew}>
            OK
          </button>
        </div>
      )}

      {phase === "done" && (
        <>
          <div className="vp-tabs" role="tablist">
            {(["clean", "raw"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`sk-chip${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
                {t === "clean" ? "CLEAN" : "RAW"}
              </button>
            ))}
            <span className="cp-note vp-meta">
              {voice.transcript ? `${voice.transcript.audioSeconds.toFixed(1)} s · ${voice.language || "auto"} · ${(voice.transcript.elapsedMs / 1000).toFixed(1)} s to transcribe` : ""}
            </span>
          </div>
          <textarea className="cp-input vp-text" readOnly value={tab === "clean" ? voice.clean : voice.raw} aria-label={`${tab} transcript`} />
          <div className="vp-row">
            <button
              className="sk-btn primary"
              onClick={() => {
                onCopy(tab === "clean" ? voice.clean : voice.raw);
                setCopied(tab);
              }}
            >
              {copied === tab ? "Copied ✓" : "Copy all"}
            </button>
            {voice.recordingPath && (
              <button className="sk-btn" onClick={onSaveRecording}>
                Save recording…
              </button>
            )}
            <button className="sk-btn" onClick={onNew}>
              New
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The dictation indicator above the cat: retro-notice shaped, like the timer chips. */
export function DictationChip({ voice, catCx, catTop }: { voice: VoiceState; catCx: number; catTop: number }) {
  if (voice.mode !== "dictation" || (voice.phase !== "recording" && voice.phase !== "transcribing" && voice.phase !== "starting")) return null;
  const listening = voice.phase !== "transcribing";
  return (
    <div className="retro-notice dictation-chip" style={{ left: catCx, top: catTop - 8 }}>
      <span className={`cp-rec-dot${listening ? " live" : ""}`} />
      <span className="retro-msg">{listening ? `Listening… ${clock(voice.seconds)}` : "Transcribing locally…"}</span>
      {listening && (
        <span className="dc-bars" aria-hidden>
          {[0.08, 0.16, 0.24].map((t) => (
            <i key={t} className={voice.level > t ? "on" : ""} />
          ))}
        </span>
      )}
    </div>
  );
}
