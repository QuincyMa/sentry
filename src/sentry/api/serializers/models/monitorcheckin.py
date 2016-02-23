from __future__ import absolute_import

from sentry.api.serializers import Serializer, register
from sentry.models import MonitorCheckIn


@register(MonitorCheckIn)
class MonitorCheckInSerializer(Serializer):
    def serialize(self, obj, attrs, user):
        return {
            'id': obj.guid,
            'status': obj.get_status_display(),
            'duration': obj.duration,
            'dateCreated': obj.date_added,
        }
