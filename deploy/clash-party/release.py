"""Official Clash Party releases for the ThinkSmart arm64 installer."""
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

import yaml

BASE = 'https://github.com/mihomo-party-org/clash-party/releases'
STATE = Path('/var/lib/thinksmart-clash')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+')
PACKAGE = 'mihomo-party'


def fetch(url, dest=None):
    # Use the device proxy if the direct connection cannot reach GitHub.
    args = ['curl', '-q', '-fsSL', '--proto', '=https', '--proto-redir', '=https',
            '--connect-timeout', '5', '--max-time', '900' if dest else '15']
    if dest:
        args += ['-o', str(dest)]
    for route in (['--noproxy', '*'], ['--noproxy', '', '--proxy', 'http://127.0.0.1:7890']):
        result = subprocess.run(args + route + [url], stdout=subprocess.PIPE)
        if result.returncode == 0:
            return result.stdout
    raise ValueError('无法从 GitHub 下载，请检查网络后重试')


def latest():
    doc = yaml.safe_load(fetch(BASE + '/latest/download/latest.yml'))
    version = doc.get('version') if isinstance(doc, dict) else None
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError('官方版本信息无效')
    return version


def installed():
    result = subprocess.run(['dpkg-query', '-W', '-f=${Status}\n${Version}', PACKAGE],
                            capture_output=True, text=True)
    fields = result.stdout.splitlines()
    return fields[1] if len(fields) == 2 and fields[0] == 'install ok installed' else ''


def newer(version, current):
    return bool(current) and subprocess.run(['dpkg', '--compare-versions', version, 'gt', current]).returncode == 0


class AssetDigest(HTMLParser):
    def __init__(self, name):
        super().__init__()
        self.label = 'Copy to clipboard digest for ' + name
        self.digest = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'clipboard-copy' and attrs.get('aria-label') == self.label:
            value = attrs.get('value', '')
            if re.fullmatch(r'sha256:[a-f0-9]{64}', value):
                self.digest = value[7:]


def download(version, dest):
    if latest() != version or not newer(version, installed()):
        raise ValueError('可用版本已变化，请重新检查')
    parser = AssetDigest(dest.name)
    parser.feed(fetch(f'{BASE}/expanded_assets/v{version}').decode())
    if not parser.digest:
        raise ValueError('官方发布页缺少此安装包的 SHA-256')
    fetch(f'{BASE}/download/v{version}/{dest.name}', dest)
    return parser.digest


def status():
    try:
        target, phase = (STATE / 'update-status').read_text().strip().split('|', 1)
    except (OSError, ValueError):
        target, phase = '', ''
    requests = STATE / 'requests'
    queued = next(requests.glob('update-*'), None)
    busy = queued is not None or (requests / 'install').exists()
    if queued and (queued.name != 'update-' + target or phase.startswith(('失败', '更新成功'))):
        phase = '等待更新'
    current = installed()
    retry = ''
    if phase.startswith('失败') and target:
        if (STATE / 'apt-pending').exists():
            retry = '重试安装'
        elif phase == '失败：启动代理设置' and target == current:
            retry = '重试启动'
    return dict(current=current, busy=busy, phase=phase, target=target, retry=retry)


def main(args):
    op = args[0]
    if op == 'digest':
        version = args[1]
        if not VERSION.fullmatch(version):
            raise ValueError('版本号无效')
        print(download(version, Path(args[2])))
        return
    state = status()
    if op == 'check' and state['current'] and not state['busy'] and not state['retry']:
        version = latest()
        state.update(latest=version, available=newer(version, state['current']))
    if op == 'queue':
        target = args[1]
        if not VERSION.fullmatch(target):
            raise ValueError('版本号无效')
        if not state['busy']:
            repair = state['target'] == target and state['retry']
            if not repair and not newer(target, state['current']):
                raise ValueError('当前没有可安装的新版本')
            (STATE / 'requests' / ('update-' + target)).touch(exist_ok=True)
        state = status()
    print(json.dumps(state))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (ValueError, OSError, yaml.YAMLError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
