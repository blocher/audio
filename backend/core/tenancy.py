"""Households: who shares a library.

Everything a person brings (Audible and Yoto accounts, podcasts, folders, cards, AI keys, preferences) belongs to their
household. People in the same household share it all; people in different households never see each other's.

The household being worked on is kept in a context variable, set for each request by ``CurrentHousehold`` and for
each background job by ``core.jobs.running``, so code deep down (settings lookups, AI clients) needn't be handed it.
"""

from contextlib import contextmanager
from contextvars import ContextVar

from django.http import Http404

_current: ContextVar[int | None] = ContextVar("household_id", default=None)


def current_household_id() -> int | None:
    return _current.get()


@contextmanager
def use_household(household_id: int | None):
    token = _current.set(household_id)
    try:
        yield
    finally:
        _current.reset(token)


def membership(user):
    """The user's Member row, creating one the first time someone without a household signs in.

    A super admin made on the server with ``createsuperuser`` joins the first household (Ben and Elizabeth's);
    anyone else gets a household of their own.
    """
    from .models import Household, Member

    cached = getattr(user, "_member_cache", None) or user._state.fields_cache.get("member")
    if cached is not None:
        return cached
    member = Member.objects.select_related("household").filter(user=user).first()
    if member:
        user._member_cache = member
        return member
    household = Household.objects.order_by("pk").first() if user.is_superuser else None
    if household is None:
        # The very first household is the server owner's, so keys in the server's environment are theirs.
        first = not Household.objects.exists()
        household = Household.objects.create(
            name=f"{user.first_name or user.username}'s library", uses_server_keys=first
        )
    user._member_cache = Member.objects.create(user=user, household=household)
    return user._member_cache


def household_id(request) -> int:
    """The signed-in person's household id (set by the middleware)."""
    hid = getattr(request, "household_id", None)
    if hid is None:
        if not request.user.is_authenticated:
            raise Http404()
        hid = membership(request.user).household_id
        request.household_id = hid
    return hid


class CurrentHousehold:
    """Middleware: remember the signed-in person's household for this request."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        hid = None
        if request.user.is_authenticated:
            hid = membership(request.user).household_id
        request.household_id = hid
        # Set rather than reset afterwards: a streaming answer keeps reading it after this returns, and every request
        # sets it again before anything reads it.
        _current.set(hid)
        return self.get_response(request)
