from django.db import migrations, models

SOURCES = ["audible", "podcasts", "folders"]
FROM_USE = {
    "yoto": ["yoto", "listen", *SOURCES],
    "ask": ["ask", "listen", *SOURCES],
}


def to_features(apps, schema_editor):
    Member = apps.get_model("core", "Member")
    for member in Member.objects.all():
        # Everyone already here (who picked "both" or nothing) keeps seeing everything.
        member.features = FROM_USE.get(member.primary_use, [])
        member.save(update_fields=["features"])


class Migration(migrations.Migration):
    dependencies = [("core", "0005_move_into_households")]

    operations = [
        migrations.AddField(model_name="member", name="features", field=models.JSONField(blank=True, default=list)),
        migrations.RunPython(to_features, migrations.RunPython.noop),
        migrations.RemoveField(model_name="member", name="primary_use"),
    ]
