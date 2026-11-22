"""Deleting someone completely, as if they had never been here: their login, their conversations and invitations,
and (when nobody else shares it) their whole library, including its audio files on disk."""

import logging
import shutil
from pathlib import Path

from django.db import transaction

from . import audio
from .models import Household, Invite, Member, Track

log = logging.getLogger(__name__)


def _remove(relative: str) -> None:
    if relative:
        audio.media_path(relative).unlink(missing_ok=True)


def _remove_dir(path: Path) -> None:
    root = Path(audio.media_path("")).resolve()
    path = path.resolve()
    if path != root and root in path.parents:  # never anything outside media, nor media itself
        shutil.rmtree(path, ignore_errors=True)


def purge_household(household: Household) -> dict:
    """Delete a library and everything in it: Audible devices are signed out at Amazon, audio files leave the disk."""
    from audible_books import client as audible
    from audible_books.models import AudibleAccount, Book
    from audible_books.services import book_dir
    from local_audio.models import Collection

    hid = household.pk
    tracks = list(Track.objects.for_household(hid))
    folders = {book_dir(b) for b in Book.objects.filter(household_id=hid).exclude(source_file="")}
    folders |= {
        audio.media_path(f"local/{pk}")
        for pk in Collection.objects.filter(household_id=hid).values_list("pk", flat=True)
    }
    for track in tracks:
        _remove(track.file)
        _remove(track.optimized_file)
        folders.add(audio.media_path(f"yoto-slices/{track.pk}"))
        if track.episode_id and track.file:
            folders.add(audio.media_path(track.file).parent)  # the show's folder
    signed_out = 0
    for account in AudibleAccount.objects.filter(household_id=hid).exclude(encrypted_auth=""):
        try:
            audible.disconnect(account)  # so the "device" disappears from their Amazon account too
            signed_out += 1
        except Exception as exc:  # noqa: BLE001 - delete it here regardless
            log.warning("Couldn't sign Audible account %s out at Amazon: %s", account.pk, exc)
    for folder in folders:
        _remove_dir(folder)
    with transaction.atomic():
        Member.objects.filter(household_id=hid).delete()
        household.delete()  # cascades to accounts, books, podcasts, folders, cards, jobs, keys and settings
    return {"tracks": len(tracks), "audible_signed_out": signed_out}


def purge_person(user) -> dict:
    """Delete a login and every trace of it. Their library goes too, unless someone else still uses it."""
    from transcripts.models import Conversation

    member = Member.objects.select_related("household").filter(user=user).first()
    household = member.household if member else None
    others = list(
        Member.objects.filter(household=household).exclude(user=user).select_related("user") if household else []
    )
    Conversation.objects.filter(owner=user).delete()
    Invite.objects.filter(accepted_user=user).delete()
    if user.email:
        Invite.objects.filter(email__iexact=user.email).delete()
    user.delete()
    if household is None:
        return {"library_deleted": False, "library_shared_with": []}
    if others:
        return {
            "library_deleted": False,
            "library_shared_with": [m.user.first_name or m.user.username for m in others],
        }
    return {"library_deleted": True, "library_shared_with": [], **purge_household(household)}
