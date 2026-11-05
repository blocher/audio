import { MessageCircle, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAction, useActiveJob } from "../hooks/queries";
import type { Book, Job } from "../types";
import { Button, errorText, useToast } from "./ui";

/** Where a book stands on the way to "ask about it". */
export function askState(book: Pick<Book, "track_count" | "transcribed_count">): "askable" | "partial" | "none" {
  if (book.track_count > 0 && book.transcribed_count >= book.track_count) return "askable";
  return book.transcribed_count > 0 ? "partial" : "none";
}

export const askLink = (bookId: number) => `/books/${bookId}?tab=ask`;

/** One click: download at the default bitrate if needed, then transcribe with the default model. */
export function useMakeAskable(bookId: number) {
  const toast = useToast();
  const job = useActiveJob("book", bookId);
  const run = useAction(() => api.post<Job>(`/audible/books/${bookId}/askable`), [["books"]]);
  const start = () =>
    run.mutate(undefined, {
      onSuccess: () => toast("Making it askable — downloading and transcribing in the background"),
      onError: (e) => toast(errorText(e), "error"),
    });
  return { job, start, pending: run.isPending };
}

/**
 * The book page's big button: "Ask about this book" once it's transcribed, "Make askable" until then, and the job's
 * progress while it runs.
 */
export function MakeAskableButton({
  book,
  size = "lg",
  variant = "sage",
  onAsk,
}: {
  book: Book;
  size?: "sm" | "lg";
  variant?: "primary" | "sage";
  onAsk?: () => void;
}) {
  const { job, start, pending } = useMakeAskable(book.id);
  const state = askState(book);
  if (job)
    return (
      <Button size={size} variant={variant} loading disabled className="askable-btn">
        {job.kind === "audible_askable" ? "Making askable" : "Working"} · {Math.round(job.progress * 100)}%
      </Button>
    );
  if (state === "askable")
    return onAsk ? (
      <Button size={size} variant={variant} icon={<MessageCircle size={18} />} onClick={onAsk} className="askable-btn">
        Ask about this book
      </Button>
    ) : (
      <Link to={askLink(book.id)} className={`btn ${variant} ${size}`}>
        <MessageCircle size={18} /> Ask about this book
      </Link>
    );
  return (
    <Button size={size} variant={variant} icon={<Sparkles size={18} />} loading={pending} onClick={start} className="askable-btn">
      {state === "partial" ? "Finish making askable" : "Make askable"}
    </Button>
  );
}

/** The footer under a book's cover in the library: straight to Ask, or one tap to get it there. */
export function CardAskFooter({ book }: { book: Pick<Book, "id" | "track_count" | "transcribed_count"> }) {
  const { job, start, pending } = useMakeAskable(book.id);
  const state = askState(book);
  if (job)
    return (
      <div className="card-ask working" title={job.message || job.title}>
        <span className="card-ask-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} />
        <Sparkles size={14} /> {job.kind === "audible_askable" ? "Making askable" : "Working"} {Math.round(job.progress * 100)}%
      </div>
    );
  if (state !== "none")
    return (
      <Link to={askLink(book.id)} className="card-ask ask">
        <MessageCircle size={14} /> Ask
      </Link>
    );
  return (
    <button type="button" className="card-ask make" onClick={start} disabled={pending}>
      <Sparkles size={14} /> {pending ? "Starting…" : "Make askable"}
    </button>
  );
}
