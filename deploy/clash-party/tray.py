#!/usr/bin/python3
"""Minimal StatusNotifierHost for Clash Party's private display."""
import json
import os
from pathlib import Path

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

WATCHER = 'org.kde.StatusNotifierWatcher'
DIR = Path('/run/thinksmart-clash')


class Watcher(dbus.service.Object):
    def __init__(self, bus):
        self.bus = bus
        self.items = []
        super().__init__(dbus.service.BusName(WATCHER, bus, do_not_queue=True), '/StatusNotifierWatcher')

    @dbus.service.method(WATCHER, in_signature='s', sender_keyword='sender')
    def RegisterStatusNotifierItem(self, service, sender=None):
        name, path = (sender, service) if service.startswith('/') else (service, '/StatusNotifierItem')
        owner = self.bus.get_name_owner(name)
        daemon = self.bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus')
        pid = daemon.GetConnectionUnixProcessID(owner, dbus_interface='org.freedesktop.DBus')
        if not (DIR / 'pid').exists() or str(pid) != (DIR / 'pid').read_text().strip():
            return
        tmp = DIR / 'tray.tmp'
        tmp.write_text(json.dumps([str(owner), str(path)]))
        os.replace(tmp, DIR / 'tray')
        self.items = [name + path]
        self.StatusNotifierItemRegistered(name + path)

    @dbus.service.signal(WATCHER, signature='s')
    def StatusNotifierItemRegistered(self, name):
        pass

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
    def Get(self, interface, name):
        return self.GetAll(interface)[name]

    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {'IsStatusNotifierHostRegistered': dbus.Boolean(True), 'ProtocolVersion': dbus.Int32(0),
                'RegisteredStatusNotifierItems': dbus.Array(self.items, signature='s')}


if __name__ == '__main__':
    DBusGMainLoop(set_as_default=True)
    watcher = Watcher(dbus.SessionBus())
    (DIR / 'watcher-ready').touch()
    GLib.MainLoop().run()
