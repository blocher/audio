"""The super admin dashboard: who's been invited, who joined, how much each library uses, and "view as" for debugging.

Impersonation signs the super admin in as someone else, remembering who they really are in the session, so the app
shows exactly what that person sees. "Stop" signs them back in as themselves.
"""

import logging
from datetime import timedelta

from django.contrib.auth import get_user_model, login
from django.db.models import Count, Q, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from .models import Household, Invite, Job, Member, Track

log = logging.getLogger(__name__)
router = Router(tags=["superadmin"])
User = get_user_model()

IMPERSONATOR = "impersonator_id"
IMPERSONATOR_NAME = "impersonator_name"


def _require_super_admin(request):
    if not request.user.is_superuser:
        raise HttpError(403, "Only a super admin can do that")


def _name(user) -> str:
    return user.first_name or user.username


def _person(user, member: Member | None) -> dict:
    return {
        "id": user.pk,
        "name": _name(user),
        "email": user.email or user.username,
        "is_admin": user.is_superuser,
        "last_login": user.last_login,
        "joined": user.date_joined,
        "onboarded": bool(member and member.onboarded_at),
        "features": member.features if member else [],
    }


def _usage(household: Household, since) -> dict:
    """What one library has and has used: content, storage, transcription and Ask."""
    from audible_books.models import AudibleAccount, Book
    from local_audio.models import Collection
    from podcasts.models import Podcast
    from transcripts.models import Message, Transcript
    from yoto.models import Playlist, YotoAccount

    from .ai import STT_PRICE_PER_HOUR

    hid = household.pk
    tracks = Track.objects.for_household(hid)
    sizes = tracks.aggregate(original=Sum("size_bytes"), optimized=Sum("optimized_size_bytes"))
    transcripts = Transcript.objects.filter(track__in=tracks, status=Transcript.Status.READY)
    recent_transcripts = transcripts.filter(updated_at__gte=since)
    cost = 0.0
    for row in transcripts.values("provider", "model").annotate(seconds=Sum("audio_seconds")):
        cost += STT_PRICE_PER_HOUR.get((row["provider"], row["model"]), 0) * (row["seconds"] or 0) / 3600
    messages = Message.objects.filter(role="assistant").filter(
        Q(conversation__book__household_id=hid)
        | Q(conversation__episode__podcast__household_id=hid)
        | Q(conversation__collection__household_id=hid)
    )

    def ask_totals(qs) -> dict:
        totals = qs.aggregate(answers=Count("id"), tokens_in=Sum("input_tokens"), tokens_out=Sum("output_tokens"))
        return {k: v or 0 for k, v in totals.items()}

    jobs = Job.objects.filter(household_id=hid)
    audible = AudibleAccount.objects.filter(household_id=hid)
    return {
        "audible_accounts": [{"name": a.name, "connected": a.connected} for a in audible],
        "yoto_connected": YotoAccount.objects.filter(household_id=hid).exclude(encrypted_tokens="").count(),
        "books": Book.objects.filter(household_id=hid).count(),
        "books_converted": Book.objects.filter(household_id=hid, status=Book.Status.READY).count(),
        "podcasts": Podcast.objects.filter(household_id=hid).count(),
        "folders": Collection.objects.filter(household_id=hid).count(),
        "cards": Playlist.objects.filter(household_id=hid).count(),
        "cards_on_yoto": Playlist.objects.filter(household_id=hid).exclude(card_id="").count(),
        "storage_bytes": (sizes["original"] or 0) + (sizes["optimized"] or 0),
        "transcribed_hours": round((transcripts.aggregate(s=Sum("audio_seconds"))["s"] or 0) / 3600, 1),
        "transcribed_hours_30d": round((recent_transcripts.aggregate(s=Sum("audio_seconds"))["s"] or 0) / 3600, 1),
        "transcription_cost_estimate": round(cost, 2),
        "ask": ask_totals(messages),
        "ask_30d": ask_totals(messages.filter(created_at__gte=since)),
        "jobs_30d": jobs.filter(created_at__gte=since).count(),
        "jobs_failed_30d": jobs.filter(created_at__gte=since, status=Job.Status.FAILED).count(),
        "last_job_at": jobs.order_by("-created_at").values_list("created_at", flat=True).first(),
    }


def _ai_keys(household: Household) -> str:
    """Whose AI keys this library uses: "own", "shared" (another library's), "server" or "none"."""
    from .api import AI_SERVICES
    from .secrets import load_credential

    if any(load_credential(s, household.pk).get("api_key") for s in AI_SERVICES):
        return "own"
    if household.ai_keys_from_id:
        return "shared"
    return "server" if household.uses_server_keys else "none"


def _invite(invite: Invite) -> dict:
    from .users import invite_link

    return {
        "id": invite.pk,
        "email": invite.email,
        "name": invite.name,
        "invited_by": _name(invite.invited_by) if invite.invited_by else "",
        "joining": invite.household.name if invite.household else None,
        "created_at": invite.created_at,
        "expires_at": invite.expires_at,
        "expired": invite.expires_at < timezone.now(),
        "emailed_at": invite.emailed_at,
        "accepted_at": invite.accepted_at,
        "accepted_user_id": invite.accepted_user_id,
        "link": None if invite.accepted_at else invite_link(invite),
    }


@router.get("/overview")
def overview(request):
    _require_super_admin(request)
    since = timezone.now() - timedelta(days=30)
    members = {m.user_id: m for m in Member.objects.select_related("household")}
    households = []
    for household in Household.objects.select_related("ai_keys_from").order_by("pk"):
        people = [
            _person(u, members.get(u.pk))
            for u in User.objects.filter(member__household=household).order_by("first_name", "username")
        ]
        households.append(
            {
                "id": household.pk,
                "name": household.name,
                "created_at": household.created_at,
                "ai_keys": _ai_keys(household),
                "ai_keys_from": household.ai_keys_from.name if household.ai_keys_from else None,
                "people": people,
                "usage": _usage(household, since),
            }
        )
    invites = Invite.objects.select_related("invited_by", "household").order_by("-created_at")
    pending = [i for i in invites if not i.accepted_at]
    accepted = [i for i in invites if i.accepted_at]
    return {
        "totals": {
            "people": User.objects.filter(is_active=True).count(),
            "libraries": len(households),
            "signed_in_30d": User.objects.filter(last_login__gte=since).count(),
            "still_setting_up": Member.objects.filter(onboarded_at__isnull=True).count(),
            "invites_pending": sum(1 for i in pending if i.expires_at >= timezone.now()),
            "invites_expired": sum(1 for i in pending if i.expires_at < timezone.now()),
            "invites_accepted": len(accepted),
            "storage_bytes": sum(h["usage"]["storage_bytes"] for h in households),
            "transcription_cost_estimate": round(
                sum(h["usage"]["transcription_cost_estimate"] for h in households), 2
            ),
        },
        "households": households,
        "invites": {"pending": [_invite(i) for i in pending], "accepted": [_invite(i) for i in accepted[:50]]},
    }


@router.delete("/households/{int:hid}")
def delete_library(request, hid: int):
    """Delete a library nobody uses any more (its people were removed), with everything in it."""
    from .purge import purge_household

    _require_super_admin(request)
    household = get_object_or_404(Household, pk=hid)
    if Member.objects.filter(household=household).exists():
        raise HttpError(400, "People still use this library; remove them first")
    return {"ok": True, **purge_household(household)}


@router.post("/impersonate/{int:user_id}")
def impersonate(request, user_id: int):
    """Sign in as someone else to see what they see. The session remembers who to switch back to."""
    if request.session.get(IMPERSONATOR):
        raise HttpError(400, "Stop viewing as the current person first")
    _require_super_admin(request)
    target = get_object_or_404(User, pk=user_id, is_active=True)
    if target.pk == request.user.pk:
        raise HttpError(400, "That's you")
    admin = request.user
    last_login = target.last_login
    login(request, target, backend="django.contrib.auth.backends.ModelBackend")  # starts a fresh session
    User.objects.filter(pk=target.pk).update(last_login=last_login)  # viewing isn't them signing in
    request.session[IMPERSONATOR] = admin.pk
    request.session[IMPERSONATOR_NAME] = _name(admin)
    log.warning("Super admin %s is viewing the app as %s", admin.username, target.username)
    return {"ok": True}


@router.post("/impersonate/stop")
def stop_impersonating(request):
    admin_id = request.session.get(IMPERSONATOR)
    if not admin_id:
        raise HttpError(400, "You aren't viewing as anyone")
    admin = get_object_or_404(User, pk=admin_id, is_active=True, is_superuser=True)
    login(request, admin, backend="django.contrib.auth.backends.ModelBackend")
    request.session.pop(IMPERSONATOR, None)
    request.session.pop(IMPERSONATOR_NAME, None)
    return {"ok": True}
