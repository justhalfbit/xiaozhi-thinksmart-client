"""Local kiosk controls for the dedicated Clash Party display."""
import asyncio
import os
from pathlib import Path

from aiohttp import WSMsgType, web

STATE = Path('/var/lib/thinksmart-clash')
DISPLAY_DIR = Path('/run/thinksmart-clash')
ASSETS = STATE / 'novnc-1.5.0'


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
    ready = phase == '就绪' and (DISPLAY_DIR / 'rfb').is_socket()
    if phase == '就绪' and not ready:
        phase = '失败：窗口服务未运行'
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


async def asset(request):
    local(request)
    path = (ASSETS / request.match_info['path']).resolve()
    if not path.is_relative_to(ASSETS) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def display(request):
    local(request, origin=True)
    try:
        reader, writer = await asyncio.open_unix_connection(DISPLAY_DIR / 'rfb')
    except OSError:
        raise web.HTTPServiceUnavailable(text='窗口尚未启动')
    try:
        with os.fdopen(os.open(DISPLAY_DIR / 'show', os.O_NONBLOCK | os.O_WRONLY), 'wb') as fifo:
            fifo.write(b'show\n')
    except OSError:
        pass  # The display may already be accepting connections during startup.
    ws = web.WebSocketResponse(protocols=('binary',))
    async def send():
        while chunk := await reader.read(65536):
            await ws.send_bytes(chunk)

    async def receive():
        async for msg in ws:
            if msg.type != WSMsgType.BINARY:
                break
            writer.write(msg.data)
            await writer.drain()

    tasks = []
    try:
        await ws.prepare(request)
        tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        await ws.close()
    return ws


async def paste(request):
    local(request, origin=True)
    text = (await request.json()).get('text')
    if not isinstance(text, str) or not 0 < len(text) <= 8192:
        raise web.HTTPBadRequest()
    env = dict(os.environ, DISPLAY=':73', XAUTHORITY=str(DISPLAY_DIR / 'Xauthority'))
    # xclip forks a background selection owner after consuming stdin.
    proc = await asyncio.create_subprocess_exec('xclip', '-selection', 'clipboard', '-in',
        env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL)
    await proc.communicate(text.encode())
    if proc.returncode:
        raise web.HTTPServiceUnavailable()
    proc = await asyncio.create_subprocess_exec('xdotool', 'key', '--clearmodifiers', 'ctrl+v', env=env)
    if await proc.wait():
        raise web.HTTPServiceUnavailable()
    return web.json_response({'ok': True})


def routes(app):
    app.router.add_get('/api/clash-party', status)
    app.router.add_post('/api/clash-party/install', install)
    app.router.add_get('/api/clash-party/display', display)
    app.router.add_post('/api/clash-party/paste', paste)
    app.router.add_get('/clash-view/{path:.*}', asset)
