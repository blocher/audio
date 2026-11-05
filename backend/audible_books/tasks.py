from celery import shared_task

from core.jobs import running
from core.models import Track

from . import services
from .models import AudibleAccount, Book


@shared_task
def sync_library_task(job_id: int, account_id: int):
    with running(job_id) as job:
        account = AudibleAccount.objects.get(pk=account_id)
        job.step(0.1, f"Reading {account.name}'s library", force=True)
        try:
            result = services.sync_library(account)
            job.step(0.7, "Fetching listening positions", force=True)
            services.sync_positions(account)
        except Exception as exc:
            AudibleAccount.objects.filter(pk=account_id).update(last_error=str(exc)[:2000])
            raise
        job.step(1.0, f"{result['total']} titles ({result['created']} new)", force=True)


def _convert(job, book_id: int, kbps: int, mono: bool, start: float = 0.0, end: float = 1.0):
    """Download (unless the master is already here) and cut chapter MP3s, reporting progress in [start, end]."""
    span = end - start
    book = Book.objects.select_related("account").get(pk=book_id)
    try:
        source = book.source_file and services.audio.media_path(book.source_file)
        if not (source and source.exists()):
            book.status = Book.Status.DOWNLOADING
            book.save(update_fields=["status"])
            job.step(start, "Downloading from Audible", force=True)
            services.download_source(book, on_progress=lambda f: job.step(start + f * 0.4 * span))
        book.status = Book.Status.CONVERTING
        book.save(update_fields=["status"])
        job.step(start + 0.4 * span, f"Converting to {kbps} kbps {'mono' if mono else 'stereo'} MP3", force=True)
        return services.convert_to_mp3(
            book, kbps, mono, on_progress=lambda f: job.step(start + (0.4 + f * 0.6) * span)
        )
    except Exception:
        Book.objects.filter(pk=book_id).update(status=Book.Status.FAILED)
        raise


@shared_task
def convert_book_task(job_id: int, book_id: int, kbps: int, mono: bool):
    with running(job_id) as job:
        tracks = _convert(job, book_id, kbps, mono)
        job.step(1.0, f"{len(tracks)} chapter MP3s ready", force=True)


@shared_task
def make_askable_task(
    job_id: int, book_id: int, kbps: int | None, mono: bool, provider: str | None = None, model: str | None = None
):
    """One click from "in my Audible library" to "ask about it": convert at the default bitrate if needed, then
    transcribe every chapter that has no transcript yet."""
    from transcripts.models import Transcript
    from transcripts.services import transcribe_track

    with running(job_id) as job:
        transcribe_from = 0.0
        if kbps and job.resumed_from:
            # A restart cut this off; if the conversion already finished, don't redo it (and lose the transcripts).
            book = Book.objects.get(pk=book_id)
            if book.status == Book.Status.READY and (book.convert_kbps, book.convert_mono) == (kbps, mono):
                kbps = None
        if kbps:
            _convert(job, book_id, kbps, mono, 0.0, 0.45)
            transcribe_from = 0.45
        tracks = list(
            Track.objects.filter(book_id=book_id)
            .exclude(file="")
            .exclude(transcript__status=Transcript.Status.READY)
            .order_by("position", "id")
        )
        for t in tracks:
            Transcript.objects.update_or_create(track=t, defaults={"status": Transcript.Status.QUEUED})
        total = sum(t.duration_ms for t in tracks) or 1
        done = 0
        span = 1.0 - transcribe_from
        for n, track in enumerate(tracks, start=1):
            job.step(
                transcribe_from + span * done / total, f"Transcribing {n}/{len(tracks)}: {track.title}", force=True
            )
            transcribe_track(
                track,
                provider,
                model,
                on_progress=lambda f, base=done, d=track.duration_ms: job.step(
                    transcribe_from + span * (base + f * d) / total
                ),
            )
            done += track.duration_ms
        job.step(1.0, f"Ready to ask: {len(tracks)} chapter(s) transcribed", force=True)


@shared_task
def sync_all_positions():
    for account in AudibleAccount.objects.exclude(encrypted_auth=""):
        try:
            services.sync_positions(account)
        except Exception:  # noqa: BLE001 - try the other accounts
            continue
