import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models import Count


def move_listening_state(apps, schema_editor):
    Book = apps.get_model("audible_books", "Book")
    LibraryEntry = apps.get_model("audible_books", "LibraryEntry")
    dupes = Book.objects.values("asin").annotate(n=Count("id")).filter(n__gt=1)
    if dupes.exists():
        raise RuntimeError(f"Merge duplicate books by hand first: {[d['asin'] for d in dupes]}")
    LibraryEntry.objects.bulk_create(
        LibraryEntry(
            account_id=b.account_id,
            book_id=b.pk,
            purchase_date=b.purchase_date,
            percent_complete=b.percent_complete,
            position_ms=b.position_ms,
            position_synced_at=b.position_synced_at,
            is_finished=b.is_finished,
        )
        for b in Book.objects.all()
    )


def put_listening_state_back(apps, schema_editor):
    Book = apps.get_model("audible_books", "Book")
    LibraryEntry = apps.get_model("audible_books", "LibraryEntry")
    for e in LibraryEntry.objects.all():
        Book.objects.filter(pk=e.book_id, account_id=e.account_id).update(
            purchase_date=e.purchase_date,
            percent_complete=e.percent_complete,
            position_ms=e.position_ms,
            position_synced_at=e.position_synced_at,
            is_finished=e.is_finished,
        )


class Migration(migrations.Migration):
    dependencies = [
        ("audible_books", "0002_book_series_list"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="LibraryEntry",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("purchase_date", models.DateTimeField(blank=True, null=True)),
                ("percent_complete", models.FloatField(default=0)),
                (
                    "position_ms",
                    models.BigIntegerField(default=0, help_text="Last listening position reported by Audible"),
                ),
                ("position_synced_at", models.DateTimeField(blank=True, null=True)),
                ("is_finished", models.BooleanField(default=False)),
                (
                    "account",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="entries",
                        to="audible_books.audibleaccount",
                    ),
                ),
                (
                    "book",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="entries", to="audible_books.book"
                    ),
                ),
            ],
            options={
                "ordering": ["account__name"],
                "constraints": [models.UniqueConstraint(fields=("account", "book"), name="one_entry_per_library")],
            },
        ),
        migrations.CreateModel(
            name="Listener",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "account",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="listeners",
                        to="audible_books.audibleaccount",
                    ),
                ),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="audible_listener",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"abstract": False},
        ),
        migrations.RunPython(move_listening_state, put_listening_state_back),
        migrations.AlterUniqueTogether(name="book", unique_together=set()),
        migrations.AlterField(model_name="book", name="asin", field=models.CharField(max_length=20, unique=True)),
        migrations.RemoveField(model_name="book", name="is_finished"),
        migrations.RemoveField(model_name="book", name="percent_complete"),
        migrations.RemoveField(model_name="book", name="position_ms"),
        migrations.RemoveField(model_name="book", name="position_synced_at"),
        migrations.RemoveField(model_name="book", name="purchase_date"),
    ]
