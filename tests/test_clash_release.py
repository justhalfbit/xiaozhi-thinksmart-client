import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    'clash_release', Path(__file__).resolve().parents[1] / 'deploy/clash-party/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def test_require_digest_for_exact_arm64_asset(tmp_path, monkeypatch):
    name = 'clash-party-linux-3.0.0-arm64.deb'
    wrong = f'<clipboard-copy aria-label="Copy to clipboard digest for other.deb" value="sha256:{"a"*64}">'
    monkeypatch.setattr(release, 'latest', lambda: '3.0.0')
    monkeypatch.setattr(release, 'installed', lambda: '2.0.4')
    monkeypatch.setattr(release, 'newer', lambda version, current: True)
    calls = []

    def fetch(url, dest=None):
        calls.append(url)
        assert dest is None
        return wrong.encode()

    monkeypatch.setattr(release, 'fetch', fetch)
    with pytest.raises(ValueError, match='SHA-256'):
        release.download('3.0.0', tmp_path / name)
    assert calls == [release.BASE + '/expanded_assets/v3.0.0']


def test_failed_restart_can_retry_same_version(tmp_path, monkeypatch):
    monkeypatch.setattr(release, 'STATE', tmp_path)
    monkeypatch.setattr(release, 'installed', lambda: '2.0.4')
    (tmp_path / 'requests').mkdir()
    (tmp_path / 'update-status').write_text('2.0.4|失败：启动代理设置\n')
    assert release.status()['retry'] == '重试启动'
    release.main(['queue', '2.0.4'])
    release.main(['queue', '2.0.4'])
    assert [p.name for p in (tmp_path / 'requests').iterdir()] == ['update-2.0.4']
    assert release.status()['busy']
