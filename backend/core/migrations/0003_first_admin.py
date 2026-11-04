from django.db import migrations


def make_first_admin(apps, schema_editor):
    """Managing people needs an admin. If nobody is one yet, the people already here (just the owner) become admins."""
    User = apps.get_model("auth", "User")
    if not User.objects.filter(is_superuser=True).exists():
        User.objects.filter(is_active=True).update(is_superuser=True, is_staff=True)


class Migration(migrations.Migration):
    dependencies = [("core", "0002_stars"), ("auth", "0012_alter_user_first_name_max_length")]

    operations = [migrations.RunPython(make_first_admin, migrations.RunPython.noop)]
