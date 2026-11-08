"""The page's update request names the client and the system layer version; the root updater
installs the system layer first (thinksmart-ubuntu-image/update/thinksmart-update)."""
import json

from thinksmart_client import update


def test_request_carries_both(tmp_path, monkeypatch):
    monkeypatch.setattr(update, 'CUSTOM_BUILD', tmp_path / 'no-marker.json')
    monkeypatch.setattr(update, 'REQUESTS', tmp_path)
    assert update.request('install', '0.2.0', '0.3.0')
    assert json.loads((tmp_path / 'install').read_text()) == {'action': 'install', 'version': '0.2.0',
                                                               'system': '0.3.0'}
    assert update.request('check')
    assert json.loads((tmp_path / 'check').read_text())['action'] == 'check'


def test_custom_build_requires_acknowledgement_only_for_client_updates(tmp_path, monkeypatch):
    marker = tmp_path / 'marker.json'
    marker.write_text(json.dumps({'label': '0.1.6 + PR4', 'client': 'abc', 'private': 'do not publish'}))
    status = tmp_path / 'status.json'; status.write_text('{"current":"0.1.6"}')
    monkeypatch.setattr(update, 'CUSTOM_BUILD', marker)
    monkeypatch.setattr(update, 'STATUS', status)
    monkeypatch.setattr(update, 'REQUESTS', tmp_path)
    assert update.read()['custom_build'] == {'label': '0.1.6 + PR4', 'commit': 'abc'}
    assert not update.request('install', '0.1.7')
    assert not (tmp_path / 'install').exists()
    assert update.request('install', '', '0.3.0')
    assert update.request('install', '0.1.7', replace_custom=True)
    assert json.loads((tmp_path / 'install').read_text())['version'] == '0.1.7'


def test_release_and_invalid_marker_have_no_custom_build(tmp_path, monkeypatch):
    marker = tmp_path / 'marker.json'
    monkeypatch.setattr(update, 'CUSTOM_BUILD', marker)
    assert update.custom_build() is None
    for content in ('broken json', '[]'):
        marker.write_text(content)
        assert update.custom_build() is None
