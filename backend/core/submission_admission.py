"""Reserve requester capacity before network work, without holding a DB lock."""
from contextlib import contextmanager
from datetime import timedelta
import threading

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from core import models

_slots = threading.BoundedSemaphore(24)


class AdmissionError(Exception):
    pass


@contextmanager
def reserve(token, identity_id):
    if not _slots.acquire(blocking=False):
        raise AdmissionError("Song lookups are busy. Please try again in a moment.")
    lease = None
    try:
        with transaction.atomic():
            from core import queue_lock
            queue_lock.acquire()
            models.ClientIdentity.objects.select_for_update().get(pk=identity_id)
            now = timezone.now()
            models.RequestReservation.objects.filter(expires_at__lte=now).delete()
            pending = (models.QueuedSong.objects.filter(Q(internal_url__isnull=True) | Q(review_status='analyzing')).count()
                       + models.RequestReservation.objects.count())
            if pending >= 64:
                raise AdmissionError("Several songs are being prepared. Please try again shortly.")
            count = (models.QueuedSong.objects.filter(requester_token=token).count()
                     + models.CurrentSong.objects.filter(requester_token=token).count()
                     + models.RequestReservation.objects.filter(requester_token=token).count())
            if count >= 5:
                raise AdmissionError("You may have up to 5 active songs at once.")
            lease = models.RequestReservation.objects.create(
                requester_token=token, expires_at=now + timedelta(minutes=5))
        yield lease
    finally:
        try:
            if lease:
                models.RequestReservation.objects.filter(pk=lease.pk).delete()
        finally:
            _slots.release()
