"""The welcome wizard: what someone new has connected so far, and how they mostly plan to use the app."""

from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from .models import Member
from .tenancy import household_id, membership

router = Router(tags=["onboarding"])


class OnboardingPatch(Schema):
    features: list[str] | None = None
    done: bool | None = None  # true: finished (or skipped) the wizard; false: show it again


def status(request) -> dict:
    from audible_books.models import AudibleAccount
    from yoto.models import YotoAccount

    from . import ai
    from .api import lookup

    member = membership(request.user)
    hid = household_id(request)
    others = Member.objects.filter(household_id=hid).exclude(user=request.user).select_related("user")
    audible = AudibleAccount.objects.filter(household_id=hid).order_by("name", "pk")
    yoto = YotoAccount.objects.filter(household_id=hid).exclude(encrypted_tokens="")
    sources = {lookup(p, "api_key")[1] for p in ai.PROVIDERS if ai.configured(p)}
    return {
        "name": request.user.first_name or request.user.username,
        "features": member.features,
        "onboarded": member.onboarded_at is not None,
        "household_name": member.household.name,
        "shared_with": [m.user.first_name or m.user.username for m in others],
        "audible": [{"id": a.pk, "name": a.name, "connected": a.connected, "locale": a.locale} for a in audible],
        "yoto": {
            "ready": bool(lookup("yoto", "client_id")[0]),
            "connected": [a.email or a.name for a in yoto],
        },
        "ai": {
            "transcribe": any(p.stt and ai.configured(p.id) for p in ai.PROVIDERS.values()),
            "ask": any(p.chat and ai.configured(p.id) for p in ai.PROVIDERS.values()),
            # Keys someone else pays for: another household's, or the server's.
            "borrowed": bool(sources) and "own" not in sources,
        },
    }


@router.get("")
def get_status(request):
    return status(request)


@router.patch("")
def update(request, payload: OnboardingPatch):
    member = membership(request.user)
    if payload.features is not None:
        allowed = (*Member.FEATURES, *Member.SOURCES)
        chosen = [f for f in allowed if f in payload.features]  # known ones, in a stable order
        # "listen" was a choice once; an old page may still send it, and it's simply dropped.
        if unknown := set(payload.features) - set(allowed) - {"listen"}:
            raise HttpError(400, f"Unknown choice: {', '.join(sorted(unknown))}")
        # Nothing ticked is fine: listening is always there.
        member.features = chosen
    if payload.done is not None:
        member.onboarded_at = timezone.now() if payload.done else None
    member.save()
    return status(request)
