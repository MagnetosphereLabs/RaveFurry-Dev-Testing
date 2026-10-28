from django.db import migrations, models
import uuid


class Migration(migrations.Migration):
    dependencies = [("core", "0022_history_requester_identity")]
    operations = [
        migrations.AddField(model_name="archivedsong", name="cached_metadata",
                            field=models.JSONField(default=dict, blank=True)),
        migrations.CreateModel(name="IpScreenDecision", fields=[
            ("ip", models.GenericIPAddressField(primary_key=True, serialize=False)),
            ("decision", models.JSONField(default=dict)),
            ("expires_at", models.DateTimeField(db_index=True)),
        ]),
        migrations.CreateModel(name="RequestReservation", fields=[
            ("id", models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
            ("requester_token", models.CharField(max_length=64, db_index=True)),
            ("expires_at", models.DateTimeField(db_index=True)),
        ]),
        migrations.CreateModel(name="RuntimeState", fields=[
            ("key", models.CharField(max_length=100, primary_key=True, serialize=False)),
            ("value", models.JSONField(default=dict)),
        ]),
    ]
