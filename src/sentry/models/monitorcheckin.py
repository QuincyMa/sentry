from __future__ import absolute_import, print_function

from django.db import models
from django.utils import timezone

from sentry.db.models import (
    GUIDField,
    Model,
    BaseManager,
    BoundedPositiveIntegerField,
    EncryptedJsonField,
    FlexibleForeignKey,
    sane_repr,
)


class CheckInStatus(object):
    UNKNOWN = 0
    SUCCESS = 1
    FAILURE = 2
    IN_PROGRESS = 3

    @classmethod
    def as_choices(cls):
        return (
            (cls.UNKNOWN, 'unknown'),
            (cls.SUCCESS, 'success'),
            (cls.FAILURE, 'failure'),
            (cls.IN_PROGRESS, 'in_progress'),
        )


class MonitorCheckIn(Model):
    __core__ = True

    guid = GUIDField()
    project_id = BoundedPositiveIntegerField(db_index=True)
    monitor = FlexibleForeignKey('sentry.Monitor')
    location = FlexibleForeignKey('sentry.MonitorLocation')
    status = BoundedPositiveIntegerField(
        default=0,
        choices=CheckInStatus.as_choices(),
    )
    config = EncryptedJsonField(default=dict)
    duration = BoundedPositiveIntegerField(null=True)
    date_added = models.DateTimeField(default=timezone.now)
    objects = BaseManager(cache_fields=('guid', ))

    class Meta:
        app_label = 'sentry'
        db_table = 'sentry_monitorcheckin'

    __repr__ = sane_repr('guid', 'project_id', 'status')
