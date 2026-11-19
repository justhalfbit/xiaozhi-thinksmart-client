"""Local touch controls for Clash Party and its running Mihomo instance."""
import asyncio
import json
import os
from urllib.parse import quote
from pathlib import Path

import aiohttp
from aiohttp import web

STATE = Path('/var/lib/thinksmart-clash')
DISPLAY_DIR = Path('/run/thinksmart-clash')
HELPER = Path(__file__).resolve().parents[1] / 'deploy/clash-party/control.py'


def local(request, *, origin=False):
    port = request.transport.get_extra_info('sockname')[1]
    if request.host not in (f'127.0.0.1:{port}', f'localhost:{port}') or request.remote not in ('127.0.0.1', '::1'):
        raise web.HTTPForbidden()
    source = request.headers.get('Origin')
    if (origin or source) and source != f'http://{request.host}':
        raise web.HTTPForbidden()


def installation_status():
    try:
        phase = (STATE / 'status').read_text().strip()
    except FileNotFoundError:
        phase = ''
    ready = phase == '就绪' and (DISPLAY_DIR / 'tray').is_file()
    if phase == '就绪' and not ready:
        phase = '失败：代理服务未就绪'
    queued = (STATE / 'requests/install').exists()
    busy = queued or bool(phase and not ready and not phase.startswith('失败'))
    return {'phase': phase, 'ready': ready, 'busy': busy}


async def status(request):
    local(request)
    return web.json_response(installation_status(), headers={'Cache-Control': 'no-store'})


async def install(request):
    local(request, origin=True)
    state = installation_status()
    if state['busy'] or state['ready']:
        return web.json_response({'ok': True})
    try:
        (STATE / 'requests/install').touch(exist_ok=True)
    except OSError:
        raise web.HTTPServiceUnavailable(text='安装服务未就绪')
    return web.json_response({'ok': True})


async def helper(**body):
    uid = os.getuid()
    env = dict(os.environ, DISPLAY=':73', XAUTHORITY=str(DISPLAY_DIR / 'Xauthority'),
               DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{uid}/bus')
    proc = await asyncio.create_subprocess_exec('/usr/bin/python3', HELPER, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    try:
        output, _ = await asyncio.wait_for(proc.communicate(json.dumps(body).encode()), 110)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    if proc.returncode:
        raise ValueError('无法访问设备上的 Clash Party')
    result = json.loads(output)
    if 'error' in result:
        raise ValueError(result['error'])
    return result


def core_session():
    pid = int((DISPLAY_DIR / 'pid').read_text())
    path = f'/tmp/mihomo-party-{os.getuid()}-{pid}.sock'
    return aiohttp.ClientSession(connector=aiohttp.UnixConnector(path=path, limit=3),
                                 timeout=aiohttp.ClientTimeout(total=20))


async def core(session, path, method='GET', **kwargs):
    async with session.request(method, 'http://localhost' + path, **kwargs) as response:
        response.raise_for_status()
        return await response.json() if response.status != 204 else None


def groups_from(proxies, mode):
    groups = []
    for name, group in proxies.items():
        if 'all' not in group or group.get('hidden') or mode == 'direct':
            continue
        if mode != 'global' and name == 'GLOBAL':
            continue
        nodes = []
        for member in group['all']:
            history = proxies.get(member, {}).get('history') or []
            delay = history[-1].get('delay') if history else None
            nodes.append({'name': member, 'delay': delay})
        groups.append({'name': name, 'current': group.get('now'), 'type': group.get('type'),
                       'selectable': group.get('type') == 'Selector', 'nodes': nodes})
    if mode == 'global':
        groups.sort(key=lambda g: g['name'] != 'GLOBAL')
    return groups


async def snapshot(session):
    cfg, proxies, state = await asyncio.gather(core(session, '/configs'), core(session, '/proxies'),
                                              helper(op='state'))
    return {k: state[k] for k in ('current', 'profiles', 'system')} | {
        'mode': cfg['mode'], 'tun': bool(cfg.get('tun', {}).get('enable')),
        'groups': groups_from(proxies['proxies'], cfg['mode'])}


def string(body, key, limit=1024):
    value = body.get(key)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError('请检查输入内容')
    return value


async def node_action(session, op, body, request):
    name = string(body, 'group')
    proxies = (await core(session, '/proxies'))['proxies']
    group = proxies.get(name, {})
    members = group.get('all', [])
    if 'all' not in group or group.get('hidden'):
        raise ValueError('代理组已变更，请刷新')
    node = body.get('node')
    if node is not None and (not isinstance(node, str) or node not in members):
        raise ValueError('节点已变更，请刷新')
    if op == 'node':
        if node is None or group['type'] != 'Selector':
            raise ValueError('此组不支持手动选择该节点')
        await core(session, '/proxies/' + quote(name, safe=''), 'PUT', json={'name': node})
        return {}
    state = await helper(op='state')
    params = {'url': state['testUrl'] or group.get('testUrl') or 'https://www.gstatic.com/generate_204',
              'timeout': min(15000, max(500, int(state['timeout'])))}
    missing = set(members) - proxies.keys()
    providers = {}
    if missing:
        for provider, data in (await core(session, '/providers/proxies'))['providers'].items():
            for p in data.get('proxies') or []:
                if p['name'] in missing:
                    providers[p['name']] = provider
    batch = body.get('nodes')
    if batch is not None:
        if not isinstance(batch, list) or not all(isinstance(n, str) and n in members for n in batch):
            raise ValueError('测速节点已变更，请刷新')
        targets = batch
    else:
        targets = [node] if node is not None else members
    todo = iter(targets)
    results = {}
    async def worker():
        for member in todo:
            if request.transport is None or request.transport.is_closing():
                return
            escaped = quote(member, safe='')
            path = '/proxies/' + escaped + '/delay'
            if member in providers:
                path = '/providers/proxies/' + quote(providers[member], safe='') + '/' + escaped + '/healthcheck'
            try:
                reply = await core(session, path, params=params)
                results[member] = reply['delay'] or 0
            except TimeoutError:
                results[member] = 0
            except aiohttp.ClientResponseError as exc:
                results[member] = 0 if exc.status in (408, 504) else None
            except (aiohttp.ClientError, KeyError, TypeError):
                results[member] = None
    await asyncio.gather(*(worker() for _ in range(3)))
    return {'delays': results}


async def change(session, op, body):
    if op == 'mode':
        expected = body.get('mode')
        if expected not in ('rule', 'global', 'direct'):
            raise ValueError('无效的代理模式')
        await helper(op=op, mode=expected)
        key = 'mode'
    elif op in ('sys', 'tun'):
        expected = body.get('value')
        if type(expected) is not bool:
            raise ValueError('开关值无效')
        await helper(op=op, value=expected)
        key = 'system' if op == 'sys' else 'tun'
    elif op == 'profile':
        expected = string(body, 'value')
        await helper(op=op, value=expected)
        key = 'current'
    elif op == 'import':
        name = body.get('name', '')
        if not isinstance(name, str) or len(name) > 128:
            raise ValueError('订阅名称过长')
        await helper(op=op, url=string(body, 'url', 8192), name=name)
        return {}
    else:
        raise ValueError('未知操作')
    for _ in range(16):
        await asyncio.sleep(.45)
        try:
            if key in ('system', 'current'):
                actual = (await helper(op='state'))[key]
                if key == 'current':
                    await core(session, '/version')
            else:
                cfg = await core(session, '/configs')
                actual = cfg['mode'] if key == 'mode' else bool(cfg.get('tun', {}).get('enable'))
        except (aiohttp.ClientError, OSError):
            continue  # Applying a profile or TUN config may restart Mihomo.
        if actual == expected:
            return {}
    raise ValueError('设置未生效，请检查系统代理或虚拟网卡权限，再刷新状态')


def routes(app):
    writes = asyncio.Lock()
    async def panel(request):
        local(request, origin=request.method == 'POST')
        try:
            async with core_session() as session:
                if request.method == 'GET':
                    result = await snapshot(session)
                else:
                    body = await request.json()
                    if not isinstance(body, dict):
                        raise ValueError('请求格式无效')
                    op = body.get('op')
                    if writes.locked():
                        return web.json_response({'error': '上一项操作正在进行'}, status=409)
                    async with writes:
                        if op in ('node', 'delay'):
                            result = await node_action(session, op, body, request)
                        else:
                            result = await change(session, op, body)
                return web.json_response(result, headers={'Cache-Control': 'no-store'})
        except (aiohttp.ClientError, OSError, TimeoutError):
            return web.json_response({'error': '代理服务暂时无法连接，请稍后重试'}, status=503)
        except ValueError as exc:
            return web.json_response({'error': str(exc)}, status=400)

    app.router.add_get('/api/clash-party', status)
    app.router.add_post('/api/clash-party/install', install)
    app.router.add_get('/api/clash-party/panel', panel)
    app.router.add_post('/api/clash-party/panel', panel)
