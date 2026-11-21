import pytest
from django.db.models.signals import post_save

from core.tenancy import use_household


@pytest.fixture(autouse=True)
def household(request):
    """Tests run inside one household, as before households existed: everyone made in a test shares it."""
    if "django_db" not in request.keywords and not {"db", "client", "django_user_model"} & set(request.fixturenames):
        yield None
        return
    request.getfixturevalue("db")
    from django.contrib.auth import get_user_model

    from core.models import Household, Member

    home = Household.objects.create(name="Home", uses_server_keys=True)

    def join(sender, instance, created, **kwargs):
        if created:
            Member.objects.get_or_create(user=instance, defaults={"household": home})

    User = get_user_model()
    post_save.connect(join, sender=User, dispatch_uid="test-join-household")
    try:
        with use_household(home.pk):
            yield home
    finally:
        post_save.disconnect(sender=User, dispatch_uid="test-join-household")
