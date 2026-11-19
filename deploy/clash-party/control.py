"""User-session controls, run with Ubuntu's Python (D-Bus, Gio, YAML)."""
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import dbus
import yaml
from gi.repository import Gio

DIR = Path('/run/thinksmart-clash')
CONFIG = Path.home() / '.config/mihomo-party'
LABELS = {
    'rule': ('Rule Mode', 'حالت قانون', 'Правило', '规则模式', '規則模式'),
    'global': ('Global Mode', 'حالت جهانی', 'Глобальный', '全局模式'),
    'direct': ('Direct Mode', 'حالت مستقیم', 'Прямой', '直连模式', '直連模式'),
    'sys': ('System Proxy', 'پراکسی سیستم', 'Системный прокси', '系统代理', '系統代理'),
    'tun': ('TUN', '虚拟网卡', '虛擬網卡'),
    'profile': ('Profiles', 'پروفایل\u200cها', 'Профили', '订阅配置', '訂閱配置'),
}


def profile_config():
    return yaml.safe_load((CONFIG / 'profile.yaml').read_text()) or {}


def get_menu():
    bus = dbus.SessionBus()
    owner, path = json.loads((DIR / 'tray').read_text())
    item = bus.get_object(owner, path)
    menu_path = item.Get('org.kde.StatusNotifierItem', 'Menu', dbus_interface='org.freedesktop.DBus.Properties')
    menu = dbus.Interface(bus.get_object(owner, menu_path), 'com.canonical.dbusmenu')
    _, root = menu.GetLayout(0, -1, ['label', 'toggle-state'])
    return menu, root[2]


def proxy_enabled():
    return Gio.Settings.new('org.gnome.system.proxy').get_string('mode') != 'none'


def event(menu, node):
    menu.Event(node[0], 'clicked', dbus.Int32(0, variant_level=1), dbus.UInt32(0))


def menu_item(children, kind):
    return next((n for n in children if n[1].get('label') in LABELS[kind]), None)


def click(kind, value):
    menu, children = get_menu()
    node = menu_item(children, kind)
    if node is None:
        raise ValueError('Clash Party 的托盘选项尚未就绪')
    if kind == 'profile':
        items = profile_config().get('items', [])
        index = next((i for i, item in enumerate(items) if item['id'] == value), None)
        if index is None:
            raise ValueError('订阅已不存在')
        # Deep-link imports update profiles before Electron rebuilds its tray.
        # Reapplying the already selected mode asks Party to rebuild that menu.
        names = [item.get('name') for item in items]
        for attempt in range(12):
            if node and [n[1].get('label', '').replace('__', '_') for n in node[2]] == names:
                break
            if attempt == 0:
                active = next((n for n in children if n[1].get('label') in
                               LABELS['rule'] + LABELS['global'] + LABELS['direct']
                               and n[1].get('toggle-state') == 1), None)
                if active:
                    event(menu, active)
            time.sleep(.25)
            menu, children = get_menu()
            node = menu_item(children, kind)
        else:
            raise ValueError('订阅列表正在更新，请稍后重试')
        node = node[2][index]
    if bool(node[1].get('toggle-state', 0)) != (value if isinstance(value, bool) else True):
        event(menu, node)


def dismiss_import_error():
    # Electron shows a synchronous GTK error dialog on the private display
    # when a deep-link import fails. Release it so the next action can run.
    pid = (DIR / 'pid').read_text().strip()
    found = subprocess.run(['xdotool', 'search', '--all', '--onlyvisible', '--pid', pid,
                            '--name', '^Error$'], capture_output=True, text=True)
    for window in found.stdout.splitlines():
        kind = subprocess.run(['xprop', '-id', window, '_NET_WM_WINDOW_TYPE'], capture_output=True, text=True)
        if '_NET_WM_WINDOW_TYPE_DIALOG' in kind.stdout:
            subprocess.run(['xdotool', 'windowfocus', window, 'key', 'Return'], check=True)
            return True
    return False


def add_subscription(url, name):
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or any(c.isspace() for c in url):
        raise ValueError('请填写完整的 HTTP 或 HTTPS 订阅地址')
    dismiss_import_error()
    before = profile_config()
    if any(item.get('url') == url for item in before.get('items', [])):
        raise ValueError('此订阅已存在')
    link = 'clash://install-config?' + urlencode({'url': url, 'name': name or parsed.hostname})
    subprocess.run(['clash-party', '--ozone-platform=x11', link], timeout=12, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    for _ in range(160):
        now = profile_config()
        item = next((p for p in now.get('items', []) if p.get('url') == url), None)
        if item:
            if before.get('current') in (None, '', 'default') and now.get('current') != item['id']:
                time.sleep(.5)
                click('profile', item['id'])
            return item['id']
        if dismiss_import_error():
            raise ValueError('订阅导入失败，请检查网络和订阅内容')
        time.sleep(.5)
    raise ValueError('未收到导入结果，请检查订阅地址和网络，再刷新列表')


def run(body):
    op = body['op']
    if op == 'state':
        cfg = profile_config()
        app = yaml.safe_load((CONFIG / 'config.yaml').read_text()) or {}
        return {'system': proxy_enabled(), 'current': cfg.get('current') or 'default',
                'profiles': [{'id': p['id'], 'name': p.get('name') or '未命名订阅'} for p in cfg.get('items', [])],
                'testUrl': app.get('delayTestUrl') or '', 'timeout': app.get('delayTestTimeout') or 5000}
    if op == 'import':
        return {'id': add_subscription(body['url'], body['name'])}
    click(body['mode'] if op == 'mode' else op, body.get('value', True))
    return {}


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except ValueError as exc:
        print(json.dumps({'error': str(exc)}) if type(exc) is ValueError else '{"error":"配置读取失败"}')
    except Exception:
        print(json.dumps({'error': 'Clash Party 未能完成操作，请检查服务状态后重试'}))
