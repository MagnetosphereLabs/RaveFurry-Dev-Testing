from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0021_durable_votes_and_played_history")]

    operations = [
        migrations.AddField(
            model_name="playbackhistory", name="requester_ip",
            field=models.CharField(max_length=45, blank=True, default=""),
        ),
        migrations.AddField(
            model_name="playbackhistory", name="requester_token",
            field=models.CharField(max_length=64, blank=True, default=""),
        ),
    ]
