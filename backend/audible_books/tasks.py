from celery import shared_task

from core.jobs import running

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


@shared_task
def convert_book_task(job_id: int, book_id: int, kbps: int, mono: bool):
    with running(job_id) as job:
        book = Book.objects.select_related("account").get(pk=book_id)
        try:
            source = book.source_file and services.audio.media_path(book.source_file)
            if not (source and source.exists()):
                book.status = Book.Status.DOWNLOADING
                book.save(update_fields=["status"])
                job.step(0, "Downloading from Audible", force=True)
                services.download_source(book, on_progress=lambda f: job.step(f * 0.4))
            book.status = Book.Status.CONVERTING
            book.save(update_fields=["status"])
            job.step(0.4, f"Converting to {kbps} kbps {'mono' if mono else 'stereo'} MP3", force=True)
            tracks = services.convert_to_mp3(book, kbps, mono, on_progress=lambda f: job.step(0.4 + f * 0.6))
        except Exception:
            Book.objects.filter(pk=book_id).update(status=Book.Status.FAILED)
            raise
        job.step(1.0, f"{len(tracks)} chapter MP3s ready", force=True)


@shared_task
def sync_all_positions():
    for account in AudibleAccount.objects.exclude(encrypted_auth=""):
        try:
            services.sync_positions(account)
        except Exception:  # noqa: BLE001 - try the other accounts
            continue
