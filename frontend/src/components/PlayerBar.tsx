import { Headphones, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward } from "lucide-react";
import { Link } from "react-router-dom";
import { clock } from "../format";
import { usePlayer } from "../player";

const RATES = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];

export default function PlayerBar() {
  const p = usePlayer();
  if (!p.current) {
    return (
      <div className="player empty">
        <div className="row" style={{ justifyContent: "center" }}>
          <Headphones size={16} /> Pick a chapter or episode to start listening
        </div>
      </div>
    );
  }
  const now = (
    <>
      {p.current.cover ? <img src={p.current.cover} alt="" /> : <div className="art" />}
      <div style={{ minWidth: 0 }}>
        <div className="now-title truncate">{p.current.title}</div>
        <div className="now-sub truncate">{p.current.subtitle}</div>
      </div>
    </>
  );
  return (
    <div className="player">
      {p.current.link ? (
        <Link to={p.current.link} className="now">
          {now}
        </Link>
      ) : (
        <div className="now">{now}</div>
      )}
      <div className="controls">
        <button className="ctrl" onClick={p.prev} aria-label="Previous">
          <SkipBack size={18} />
        </button>
        <button className="ctrl" onClick={() => p.skip(-15000)} aria-label="Back 15 seconds">
          <RotateCcw size={19} />
        </button>
        <button className="ctrl main-play" onClick={p.toggle} aria-label={p.playing ? "Pause" : "Play"}>
          {p.playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" style={{ marginLeft: 3 }} />}
        </button>
        <button className="ctrl" onClick={() => p.skip(30000)} aria-label="Forward 30 seconds">
          <RotateCw size={19} />
        </button>
        <button className="ctrl" onClick={p.next} aria-label="Next" disabled={p.index >= p.queue.length - 1}>
          <SkipForward size={18} />
        </button>
      </div>
      <div className="scrub">
        <span className="tabular">{clock(p.positionMs)}</span>
        <input
          type="range"
          min={0}
          max={p.durationMs || 1}
          value={p.positionMs}
          step={1000}
          onChange={(e) => p.seek(Number(e.target.value))}
          aria-label="Seek"
        />
        <span className="tabular">{clock(p.durationMs)}</span>
      </div>
      <div className="extras row">
        <select className="rate" value={p.rate} onChange={(e) => p.setRate(Number(e.target.value))} aria-label="Speed">
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
        {p.queue.length > 1 && (
          <span className="muted tabular" style={{ fontSize: "var(--text-sm)" }}>
            {p.index + 1}/{p.queue.length}
          </span>
        )}
      </div>
    </div>
  );
}
