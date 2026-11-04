import { Star } from "lucide-react";
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
  const label = on ? `Unstar ${title}` : `Star ${title}`;
  return (
    <button
      type="button"
      className={`star-btn ${overlay ? "overlay" : ""} ${on ? "on" : ""}`}
      aria-pressed={on}
      aria-label={label}
      title={on ? "Starred: on your home page" : "Star to keep it on your home page"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ kind, id, on: !on });
      }}
    >
      <Star size={overlay ? 17 : 18} fill={on ? "currentColor" : "none"} />
      {!overlay && <span>{on ? "Starred" : "Star"}</span>}
    </button>
  );
}
