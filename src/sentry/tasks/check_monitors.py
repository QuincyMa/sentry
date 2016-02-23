from __future__ import absolute_import, print_function

from django.utils import timezone

from sentry.models import Monitor, MonitorStatus, MonitorType
from sentry.signals import monitor_failed
from sentry.tasks.base import instrumented_task


@instrumented_task(name='sentry.tasks.check_monitors', time_limit=15, soft_time_limit=10)
def check_monitors():
    qs = Monitor.objects.filter(
        type__in=[MonitorType.HEARTBEAT, MonitorType.CRON_JOB],
        next_checkin__lt=timezone.now(),
    )
    for monitor in qs:
        affected = Monitor.objects.filter(
            id=monitor.id,
            last_checkin=monitor.last_checkin,
        ).update(
            next_checkin=monitor.get_next_scheduled_checkin(timezone.now()),
            status=MonitorStatus.FAILING,
        )
        if affected:
            # TODO: generate an event!
            monitor_failed.send(monitor=monitor, sender=check_monitors)
