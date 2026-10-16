import { useState } from "react";
import { ChevronRight } from "lucide-react";

/* Dock fact rows: a muted label on the left and its value on the right, one
   hairline apart, so a step's counts read down one column. Help text lives in
   the row's tooltip; a row with a list behind it opens in place. Rows render
   inside <Facts>. */

export function Facts({ label, children }) {
  return <dl className="lv-facts" aria-label={label}>{children}</dl>;
}

function toneClass(tone, text) {
  return [tone ? `is-${tone}` : "", text ? "is-text" : ""].filter(Boolean).join(" ") || undefined;
}

/** One row. Values are mono counts unless `text` (a status in words). `note`
    is a short line under the row for something the user must read, like why
    a switch is unavailable. */
export function Fact({ label, title, tone, text, note, children }) {
  return (
    <div className="lv-fact">
      <dt title={title}>{label}</dt>
      <dd className={toneClass(tone, text)} title={title}>{children}</dd>
      {note ? <dd className="lv-fact-note">{note}</dd> : null}
    </div>
  );
}

/** A row that opens to its list. `extra` sits beside the value and stays
    clickable on its own (a Retry link, say). Pass `open` and `onOpenChange`
    when the content can close itself. */
export function FactDisclosure({ label, value, tone, text, title, note, extra, ariaLabel, open: controlled, onOpenChange, className = "", children }) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const toggle = () => (onOpenChange ? onOpenChange(!open) : setOwn((was) => !was));
  return (
    <div className={`lv-fact is-disclosure ${open ? "is-open" : ""} ${className}`.trim()}>
      <dt title={title}>
        <button type="button" className="lv-fact-toggle" aria-expanded={open} aria-label={ariaLabel} onClick={toggle}>
          {label}
        </button>
      </dt>
      <dd className={toneClass(tone, text)} title={title}>
        {value}
        {extra}
        <ChevronRight className="lv-fact-chev" aria-hidden="true" />
      </dd>
      {note ? <dd className="lv-fact-note">{note}</dd> : null}
      {open ? <dd className="lv-fact-more">{children}</dd> : null}
    </div>
  );
}

/** The Status row of a dock's open file. Given `describe` (unsaved edits), it
    opens to what changed; `describe` runs only while the list is open. */
export function StatusFact({ status, tone, title, note, extra, describe }) {
  const value = <><span className="lv-dot" aria-hidden="true" />{status}</>;
  if (!describe) {
    return <Fact label="Status" tone={tone} text title={title} note={note}>{value}{extra}</Fact>;
  }
  return (
    <FactDisclosure label="Status" value={value} tone={tone} text title={title ?? "Show what changed"} note={note}
      extra={extra} ariaLabel="Status: show what changed">
      <ChangeList describe={describe} />
    </FactDisclosure>
  );
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A step's checks as one row that opens to the list. `checks`:
    [{ key, text, tone: "error" | "warn" | "info" }]. The value names the most
    serious kind, in its colour, so a closed row still says how much it matters. */
export function ChecksFact({ checks }) {
  if (!checks.length) return <Fact label="Checks" title="Ready to save">none</Fact>;
  const count = (tone) => checks.filter((entry) => entry.tone === tone).length;
  const errors = count("error");
  const warnings = count("warn");
  const lead = errors ? `${errors} blocking` : warnings ? plural(warnings, "warning") : plural(checks.length, "note");
  const rest = checks.length - (errors || warnings || checks.length);
  const tone = errors ? "error" : warnings ? "warn" : "info";
  return (
    <FactDisclosure label="Checks" tone={tone} text ariaLabel="Checks: show the list"
      value={<><span className="lv-dot" aria-hidden="true" />{rest ? `${lead} and ${rest} more` : lead}</>}
      title={errors ? "Fix the blocking checks before saving" : "Nothing here stops a save"}>
      <FactList items={checks} />
    </FactDisclosure>
  );
}

function ChangeList({ describe }) {
  const lines = describe();
  if (!lines.length) return <p className="lv-fact-empty">No field the editor shows has changed.</p>;
  return <FactList items={lines.map((text) => ({ text }))} />;
}

/** A plain list for a disclosure row. */
export function FactList({ items }) {
  return (
    <ul className="lv-fact-list">
      {items.map((item, index) => (
        <li key={`${index}:${item.key ?? item.text}`} className={toneClass(item.tone)}>{item.text}</li>
      ))}
    </ul>
  );
}
