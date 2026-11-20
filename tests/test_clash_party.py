from types import SimpleNamespace

import pytest
from aiohttp import web
from thinksmart_client import clash_party


def test_retry_and_ready_states(tmp_path, monkeypatch):
    monkeypatch.setattr(clash_party, 'STATE', tmp_path)
    monkeypatch.setattr(clash_party, 'DISPLAY_DIR', tmp_path)
    (tmp_path / 'requests').mkdir()
    queued = tmp_path / 'requests/install'
    assert not clash_party.installation_status()['busy']
    queued.touch()
    assert clash_party.installation_status()['busy']
    queued.unlink()
    status = tmp_path / 'status'
    status.write_text('失败：下载官方安装包')
    assert not clash_party.installation_status()['busy']
    status.write_text('就绪')
    assert not clash_party.installation_status()['ready']
    (tmp_path / 'tray').write_text('[]')
    assert clash_party.installation_status()['ready']


def test_local_origin_required_for_controls():
    request = SimpleNamespace(host='localhost:8090', remote='127.0.0.1', headers={},
                              transport=SimpleNamespace(get_extra_info=lambda key: ('127.0.0.1', 8090)))
    for source in (None, 'http://other.local'):
        request.headers = {'Origin': source} if source else {}
        with pytest.raises(web.HTTPForbidden):
            clash_party.local(request, origin=True)
    request.headers['Origin'] = 'http://localhost:8090'
    clash_party.local(request, origin=True)

def test_groups_follow_mode_and_selection_policy():
    proxies = {
        'GLOBAL': {'all': ['组'], 'type': 'Selector', 'now': '组'},
        '组': {'all': ['节点/一'], 'type': 'URLTest', 'now': '节点/一'},
        '隐藏': {'all': [], 'hidden': True},
        '节点/一': {'history': [{'delay': 23}]},
    }
    assert clash_party.groups_from(proxies, 'direct') == []
    assert [g['name'] for g in clash_party.groups_from(proxies, 'global')] == ['GLOBAL', '组']
    group, = clash_party.groups_from(proxies, 'rule')
    assert not group['selectable']
    assert group['nodes'] == [{'name': '节点/一', 'delay': 23}]
