"""Shared by the migrations that moved a single-library install into households."""

from django.utils import timezone

SUPER_ADMIN_NAMES = {"ben", "benjamin", "elizabeth", "liz"}


def first_household(apps):
    """The household everything that existed before households belongs to, made if it isn't there yet."""
    Household = apps.get_model("core", "Household")
    household = Household.objects.order_by("pk").first()
    if household is None:
        User = apps.get_model("auth", "User")
        names = [u.first_name or u.username for u in User.objects.filter(is_active=True).order_by("pk")[:2]]
        name = f"{' & '.join(names)}'s library" if names else "Family library"
        household = Household.objects.create(name=name, uses_server_keys=True)
    return household


def move_users_in(apps, schema_editor):
    """Everyone already here shares the first household and skips the welcome wizard. Ben and Elizabeth are super
    admins."""
    User = apps.get_model("auth", "User")
    Member = apps.get_model("core", "Member")
    Credential = apps.get_model("core", "Credential")
    Job = apps.get_model("core", "Job")
    users = list(User.objects.order_by("pk"))
    if not users and not Credential.objects.exists():
        return  # a fresh install: the first person to sign in gets a household then
    household = first_household(apps)
    now = timezone.now()
    for user in users:
        Member.objects.get_or_create(
            user=user, defaults={"household": household, "onboarded_at": now}
        )
        if {user.username.strip().lower(), user.first_name.strip().lower()} & SUPER_ADMIN_NAMES:
            user.is_superuser = user.is_staff = True
            user.save(update_fields=["is_superuser", "is_staff"])
    Credential.objects.exclude(service="yoto").filter(household__isnull=True).update(household=household)
    Job.objects.filter(household__isnull=True).update(household=household)


def filler(app_label: str, *model_names: str):
    """A RunPython function that puts every existing row of these models in the first household."""

    def fill(apps, schema_editor):
        models = [apps.get_model(app_label, name) for name in model_names]
        if not any(m.objects.filter(household__isnull=True).exists() for m in models):
            return
        household = first_household(apps)
        for model in models:
            model.objects.filter(household__isnull=True).update(household=household)

    return fill
