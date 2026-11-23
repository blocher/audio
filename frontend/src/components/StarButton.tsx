import { Star } from "lucide-react";
import { useState } from "react";
import { useStars, useToggleStar, type StarKind } from "../hooks/stars";

/** Star or unstar a book, podcast or folder for the signed-in user. Safe to put inside a link. */
export function StarButton({
  kind,
  id,
  title,
  overlay = false,
}: {
  kind: StarKind;
  id: number;
  title: string;
  overlay?: boolean;
}) {
  const stars = useStars();
  const toggle = useToggleStar();
  const on = stars.isStarred(kind, id);
  const [pop, setPop] = useState(0);
  const label = on ? `Unstar ${title}` : `Star ${title}`;
  return (
    <button
      type="button"
      className={`star-btn ${overlay ? "overlay" : ""} ${on ? "on" : ""} ${pop ? "pop" : ""}`}
      onAnimationEnd={() => setPop(0)}
      aria-pressed={on}
      aria-label={label}
      title={on ? "Starred: on My Shelf" : "Star to keep it on My Shelf"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!on) setPop((n) => n + 1);
        toggle.mutate({ kind, id, on: !on });
      }}
    >
      <Star size={overlay ? 17 : 18} fill={on ? "currentColor" : "none"} />
      {!overlay && <span>{on ? "Starred" : "Star"}</span>}
    </button>
  );
}
