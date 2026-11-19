import socket
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
    with socket.socket(socket.AF_UNIX) as s:
        monkeypatch.chdir(tmp_path)
        s.bind('rfb')
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
