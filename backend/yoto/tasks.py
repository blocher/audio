from celery import shared_task

from core.jobs import running

from .models import Playlist
from .services import sync_playlist


@shared_task
def sync_playlists_task(job_id: int, playlist_ids: list[int]):
    with running(job_id) as job:
        playlists = list(Playlist.objects.filter(pk__in=playlist_ids).select_related("account").order_by("id"))
        failures = []
        for n, playlist in enumerate(playlists):

            def report(fraction, message=None, n=n):
                prefix = f"Card {n + 1}/{len(playlists)} · " if len(playlists) > 1 else ""
                job.step((n + fraction) / len(playlists), f"{prefix}{message}" if message else None)

            try:
                sync_playlist(playlist, on_progress=report)
            except Exception as exc:
                failures.append(f"{playlist.title}: {exc}")
                if len(playlists) == 1:
                    raise
        if failures:
            raise RuntimeError(f"{len(failures)} of {len(playlists)} cards failed: " + "; ".join(failures)[:1500])
        job.step(1.0, f"Synced {len(playlists)} card(s) to Yoto", force=True)


@shared_task
def send_to_yoto_task(
    job_id: int,
    groups: list[dict],
    strategy: str,
    kbps: int | None,
    mono: bool,
    name: str,
    cover_url: str,
    batch: str,
    book_id: int | None = None,
    convert_kbps: int | None = None,
):
    """One click from "in my library" to "on my Yoto": download and convert an Audible book if it isn't yet, fit it
    onto as few 500 MB cards as possible, downsize if asked, and upload every card to the Yoto account."""
    from audible_books.models import Book
    from audible_books.tasks import _convert
    from core.api import PackIn, run_pack
    from core.models import Track
    from core.tasks import optimize_track

    from . import services

    with running(job_id) as job:
        progress = 0.0
        if book_id is not None:
            book = Book.objects.get(pk=book_id)
            if convert_kbps:
                done = book.status == Book.Status.READY and book.tracks.exclude(file="").exists()
                if not done:
                    _convert(job, book_id, convert_kbps, mono, 0.0, 0.5)
                    progress = 0.5
            track_ids = list(book.tracks.exclude(file="").order_by("position", "id").values_list("pk", flat=True))
            groups = [{"key": f"book:{book.pk}", "title": book.title, "series": book.series, "track_ids": track_ids}]

        # A restart part way through: the cards were already made, so carry on with them rather than make them twice.
        playlists = list(Playlist.objects.filter(batch=batch, household_id=job.job.household_id).order_by("id"))
        if not playlists:
            job.step(progress, "Fitting it onto cards", force=True)
            payload = PackIn(groups=groups, strategy=strategy, kbps=kbps, use_optimized=True)
            try:
                cards, _ = run_pack(payload)
            except Exception as exc:  # HttpError from the packer carries a readable message
                raise RuntimeError(getattr(exc, "message", None) or str(exc)) from exc
            if not cards:
                raise RuntimeError("There's no audio to put on a card yet.")
            playlists = services.create_from_cards(cards, None, cover_url, name, batch)

        if kbps:
            ids = {i.track_id for p in playlists for i in p.items.all()}
            stale = list(
                Track.objects.filter(pk__in=ids)
                .exclude(file="")
                .exclude(optimized_bitrate_kbps=kbps, optimized_mono=mono)
                .order_by("pk")
            )
            span = 0.25 * (1 - progress)
            total = sum(t.duration_ms for t in stale) or 1
            done_ms = 0
            for n, track in enumerate(stale, start=1):
                base = progress + span * done_ms / total
                job.step(base, f"Making the files smaller ({n} of {len(stale)})", force=True)
                optimize_track(
                    track,
                    kbps,
                    mono,
                    on_progress=lambda f, b=done_ms, d=track.duration_ms: job.step(
                        progress + span * (b + f * d) / total
                    ),
                )
                done_ms += track.duration_ms
            progress += span

        span = 1.0 - progress
        failures = []
        for n, playlist in enumerate(playlists):
            if playlist.status == Playlist.Status.SYNCED:
                continue  # already sent before a restart

            def report(fraction, message=None, n=n):
                prefix = f"Card {n + 1} of {len(playlists)} · " if len(playlists) > 1 else ""
                job.step(
                    progress + span * (n + fraction) / len(playlists),
                    f"{prefix}{message}" if message else None,
                )

            report(0, "Uploading to Yoto")
            try:
                sync_playlist(playlist, on_progress=report)
            except Exception as exc:
                failures.append(f"{playlist.title}: {exc}")
                if len(playlists) == 1:
                    raise
        if failures:
            raise RuntimeError(f"{len(failures)} of {len(playlists)} cards failed: " + "; ".join(failures)[:1500])
        count = len(playlists)
        job.step(1.0, f"On Yoto: {count} card{'' if count == 1 else 's'} · batch {batch}", force=True)
