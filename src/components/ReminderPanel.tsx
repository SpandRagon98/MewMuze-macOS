import { useState } from "react";
import { makeScheduled } from "../productivity/scheduledReminders";
import type { ScheduledReminder } from "../settings/defaultSettings";

/**
 * Compact "Add note" dialog from the right-click menu: one line of text that
 * rides above the cat as a chat balloon until hidden.
 */
export function NotePanel({
  initial,
  onSave,
  onHide,
  onClose,
}: {
  initial: string;
  onSave: (text: string) => void;
  onHide: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="sk-backdrop">
      <div className="sk-panel reminder-panel" role="dialog" aria-label="Add note">
        <div className="sk-titlebar">
          <span className="sk-title">
            <span className="sk-title-badge">📝</span> Add Note
          </span>
          <div className="sk-window-btns">
            <button className="sk-winbtn close" title="Close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="reminder-body">
          <div className="sk-row">
            <label className="sk-label">Note</label>
            <input
              className="sk-input wide"
              value={text}
              maxLength={120}
              placeholder="Stand-up at 11:00"
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) onSave(text.trim());
              }}
            />
          </div>
          <div className="reminder-actions">
            {initial && (
              <button className="sk-btn danger" onClick={onHide}>
                Hide note
              </button>
            )}
            <button className="sk-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="sk-btn primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact "Set Reminder" panel opened from the cat's right-click menu.
 * Skeuomorphic-retro, matching the settings panel's `--sk-*` styling: title,
 * date, time, an optional early warning, Save / Cancel. Everything stays
 * local — reminders live in settings.json like every other preference.
 */
export function ReminderPanel({
  onSave,
  onClose,
}: {
  onSave: (reminder: ScheduledReminder) => void;
  onClose: () => void;
}) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const [time, setTime] = useState(`${pad(now.getHours())}:${pad((now.getMinutes() + 5) % 60)}`);
  const [warn, setWarn] = useState(5);
  const [error, setError] = useState("");

  const save = () => {
    const r = makeScheduled(title, date, time, warn);
    if (!r) {
      setError(title.trim() ? "That date and time don't parse." : "Give the reminder a title.");
      return;
    }
    if (r.dueUnix <= Math.floor(Date.now() / 1000)) {
      setError("That time is already in the past.");
      return;
    }
    onSave(r);
  };

  return (
    <div className="sk-backdrop">
      <div className="sk-panel reminder-panel" role="dialog" aria-label="Set reminder">
        <div className="sk-titlebar">
          <span className="sk-title">
            <span className="sk-title-badge">⏰</span> Set Reminder
          </span>
          <div className="sk-window-btns">
            <button className="sk-winbtn close" title="Close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="reminder-body">
          <div className="sk-row">
            <label className="sk-label">Title</label>
            <input
              className="sk-input wide"
              value={title}
              maxLength={60}
              placeholder="Stakeholder Meeting"
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="sk-row">
            <label className="sk-label">Date</label>
            <input className="sk-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="sk-row">
            <label className="sk-label">Time</label>
            <input className="sk-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="sk-row">
            <label className="sk-label">Early warning</label>
            <select className="sk-input" value={warn} onChange={(e) => setWarn(Number(e.target.value))}>
              <option value={0}>None</option>
              <option value={1}>1 minute before</option>
              <option value={5}>5 minutes before</option>
              <option value={10}>10 minutes before</option>
              <option value={15}>15 minutes before</option>
            </select>
          </div>
          {error && <div className="reminder-error">{error}</div>}
          <div className="reminder-actions">
            <button className="sk-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="sk-btn primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
