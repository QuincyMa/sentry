from __future__ import absolute_import, print_function

from croniter import croniter
from datetime import datetime, timedelta
from django.db import models
from django.utils import timezone
from uuid import uuid4

from sentry.constants import ObjectStatus
from sentry.db.models import (
    GUIDField,
    Model,
    BoundedPositiveIntegerField,
    EncryptedJsonField,
    sane_repr,
)


def generate_secret():
    return uuid4().hex + uuid4().hex


class MonitorStatus(ObjectStatus):
    ACTIVE = 0
    DISABLED = 1
    PENDING_DELETION = 2
    DELETION_IN_PROGRESS = 3
    FAILING = 4

    @classmethod
    def as_choices(cls):
        return (
            (cls.ACTIVE, 'active'),
            (cls.DISABLED, 'disabled'),
            (cls.PENDING_DELETION, 'pending_deletion'),
            (cls.DELETION_IN_PROGRESS, 'deletion_in_progress'),
            (cls.FAILING, 'failing'),
        )


class MonitorType(object):
    UNKNOWN = 0
    HEALTH_CHECK = 1
    HEARTBEAT = 2
    CRON_JOB = 3

    @classmethod
    def as_choices(cls):
        return (
            (cls.UNKNOWN, 'unknown'),
            (cls.HEALTH_CHECK, 'health_check'),
            (cls.HEARTBEAT, 'heartbeat'),
            (cls.CRON_JOB, 'cron_job'),
        )


class Monitor(Model):
    __core__ = True

    guid = GUIDField()
    organization_id = BoundedPositiveIntegerField(db_index=True)
    project_id = BoundedPositiveIntegerField(db_index=True)
    name = models.CharField(max_length=128)
    status = BoundedPositiveIntegerField(
        default=MonitorStatus.ACTIVE,
        choices=MonitorStatus.as_choices(),
    )
    type = BoundedPositiveIntegerField(
        default=MonitorType.UNKNOWN,
        choices=MonitorType.as_choices(),
    )
    config = EncryptedJsonField(default=dict)
    next_checkin = models.DateTimeField(null=True)
    last_checkin = models.DateTimeField(null=True)
    date_added = models.DateTimeField(default=timezone.now)

    class Meta:
        app_label = 'sentry'
        db_table = 'sentry_monitor'

    __repr__ = sane_repr('guid', 'project_id', 'name')

    def get_next_scheduled_checkin(self, last_checkin=None):
        if last_checkin is None:
            last_checkin = self.last_checkin
        itr = croniter(self.config['schedule'], last_checkin)
        next_checkin = itr.get_next(datetime)
        return next_checkin + \
            timedelta(minutes=int(self.config.get('checkin_margin') or 0))
