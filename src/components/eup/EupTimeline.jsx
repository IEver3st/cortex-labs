import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Pause, Play } from "lucide-react";
import { PLAYBACK_SPEEDS, clipEndTime, clipFrame, formatClipSeconds } from "../../lib/eup-playback";
import { Toggle } from "../ui/toggle";

function speedLabel(speed) {
  return `${speed}×`;
}

/**
 * Playback for the clip on the stage: play or pause, a frame scrubber, speed
 * and loop. While the clip plays, the page moves the scrubber through
 * `ref.update(time)`, a direct DOM write, so playback never re-renders React.
 * Scrubbing pauses; `onScrubEnd` reports the frame the user settled on.
 */
const EupTimeline = forwardRef(function EupTimeline(
  { clip, playing, onTogglePlay, getTime, onScrub, onScrubEnd, speed, onSpeedChange, loop, onLoopChange },
  ref,
) {
  const inputRef = useRef(null);
  const frameRef = useRef(null);
  const timeRef = useRef(null);
  const shownRef = useRef(-1);
  const duration = clip?.duration || 0;
  const end = clipEndTime(duration);
  const step = clip?.sampleRate > 0 ? 1 / clip.sampleRate : 1 / 30;

  const show = useCallback((time, force = false) => {
    const { frame, frames } = clipFrame(time, clip);
    // Clips are sampled at 30 fps; skip the writes between frames.
    if (!force && frame === shownRef.current) return;
    shownRef.current = frame;
    const input = inputRef.current;
    if (input) {
      input.value = String(Math.min(Math.max(time, 0), end));
      input.style.setProperty("--fill", `${end > 0 ? (Math.min(time, end) / end) * 100 : 0}%`);
    }
    if (frameRef.current) frameRef.current.textContent = `Frame ${frame} of ${frames}`;
    if (timeRef.current) timeRef.current.textContent = `${formatClipSeconds(time)} of ${formatClipSeconds(duration)}`;
  }, [clip, duration, end]);

  useImperativeHandle(ref, () => ({ update: (time) => show(time) }), [show]);

  useEffect(() => {
    show(getTime(), true);
  }, [clip, playing, getTime, show]);

  const scrub = (event) => {
    const time = Number(event.target.value);
    onScrub(time);
    show(time, true);
  };
  const settle = (event) => onScrubEnd(Number(event.currentTarget.value));

  return (
    <div className="lv-field eup-timeline">
      <div className="eup-timeline-row">
        <button
          type="button"
          className="cx-icon-btn"
          onClick={onTogglePlay}
          aria-label={playing ? "Pause the animation" : "Play the animation"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <label className="lv-slider eup-timeline-scrub" htmlFor="eup-timeline-time">
          <span className="lv-slider-head">
            <span className="lv-slider-label" ref={frameRef}>Frame 0</span>
            <output className="lv-slider-value" htmlFor="eup-timeline-time" ref={timeRef} />
          </span>
          <input
            ref={inputRef}
            id="eup-timeline-time"
            type="range"
            min={0}
            max={end}
            step={step}
            defaultValue={0}
            aria-label="Animation frame"
            onChange={scrub}
            onPointerUp={settle}
            onKeyUp={settle}
          />
        </label>
      </div>
      <div className="eup-timeline-opts">
        <div className="lv-seg" role="radiogroup" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={speed === value}
              className={`lv-seg-btn ${speed === value ? "is-on" : ""}`}
              onClick={() => onSpeedChange(value)}
              title={`Play at ${speedLabel(value)} speed`}
            >
              {speedLabel(value)}
            </button>
          ))}
        </div>
        <div className="lv-toggle-row eup-timeline-loop">
          <span>Loop</span>
          <Toggle checked={loop} onChange={onLoopChange} ariaLabel="Loop the animation" />
        </div>
      </div>
    </div>
  );
});

export default memo(EupTimeline);
