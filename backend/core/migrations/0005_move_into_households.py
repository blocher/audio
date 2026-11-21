from django.db import migrations

from core.migration_helpers import move_users_in


class Migration(migrations.Migration):
    dependencies = [("core", "0004_households")]

    operations = [migrations.RunPython(move_users_in, migrations.RunPython.noop)]
