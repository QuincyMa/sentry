from __future__ import absolute_import

from django.conf import settings
from django.db.models import CharField
from uuid import uuid4


def generate_guid():
    return uuid4().hex


class GUIDField(CharField):
    def __init__(self):
        super(GUIDField, self).__init__(max_length=32, unique=True, default=generate_guid)


if 'south' in settings.INSTALLED_APPS:
    from south.modelsinspector import add_introspection_rules

    add_introspection_rules([], ["^sentry\.db\.models\.fields\.guid\.GUIDField"])
