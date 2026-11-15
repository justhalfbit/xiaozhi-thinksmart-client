"""Durable scheduled queries and cancellation, without network or audio hardware."""
import asyncio
from types import SimpleNamespace

import pytest
import test_barge_in  # hardware stubs, same as the existing alarm tests
from thinksmart_client import tasks, mcp, app


@pytest.fixture
def store(tmp_path):
    return tasks.Store(tmp_path, clock=lambda: 1794610800.)


def create(store, **kw):
    return store.create('查询执行当天杭州天气并播报', tools=['get_weather'], minutes=1, **kw)


def test_claim_advances_daily_and_restart_never_repeats(store):
    item = store.create('当天新闻', tools=['web_search'], time='07:00', repeat={'type': 'daily'})
    occurrence = item['at']
    _, run = store.claim(occurrence)
    assert store.items[0]['at'] > occurrence
    restored = tasks.Store(store.path.parent, clock=lambda: occurrence)
    assert restored.runs[0]['status'] == 'interrupted'
    assert restored.claim(occurrence) is None


def test_one_off_and_missed_occurrence_are_not_reclaimed(store):
    item = create(store)
    _, run = store.claim(item['at'] + 3601)
    assert run['status'] == 'missed'
    assert store.claim(item['at'] + 3602) is None


def test_validation_preserves_existing_data(store):
    create(store)
    for bad in ['shell', 'self.task.create']:
        with pytest.raises(ValueError): store.create('test', tools=[bad], minutes=1)
    assert len(store.items) == 1
    store.path.write_text('{broken')
    broken = tasks.Store(store.path.parent)
    assert broken.view()['error']
    assert broken.claim(9999999999) is None
    with pytest.raises(ValueError): create(broken)
    assert store.path.read_text() == '{broken'


def runner(store, execute, speak, busy=lambda: False):
    return tasks.Runner(store, execute, speak, busy, lambda _: None, synced=lambda: True)


@pytest.mark.asyncio
async def test_serial_once_and_result_persisted(store):
    item = create(store)
    store.clock = lambda: item['at']
    called, spoken = [], []
    async def execute(i):
        called.append(i['id'])
        await asyncio.sleep(0)
        return {'ok': True, 'text': '当天杭州晴天', 'sources': []}
    async def speak(t): spoken.append(t)
    r = runner(store, execute, speak)
    await r.tick(); await r.tick()
    await r.worker
    await r.tick()
    assert called == [item['id']] and spoken == ['当天杭州晴天']
    assert store.runs[0]['status'] == 'completed'


@pytest.mark.parametrize('before_start', [False, True])
@pytest.mark.asyncio
async def test_stop_or_delete_cancels_without_late_audio(store, before_start):
    item = create(store); store.clock = lambda: item['at']
    started = asyncio.Event(); audio = []
    async def execute(i):
        started.set(); await asyncio.sleep(100)
    async def speak(t): audio.append(t)
    r = runner(store, execute, speak)
    await r.tick()
    if not before_start: await started.wait()
    assert await r.remove(item['id'])
    assert store.runs[0]['status'] == 'cancelled'
    assert not store.items and not audio


@pytest.mark.asyncio
async def test_failure_does_not_speak_or_stay_running(store):
    item = create(store); store.clock = lambda: item['at']
    async def execute(i): return {'ok': False, 'error': '联网查询失败'}
    async def speak(t): pytest.fail('failed task must not speak fabricated results')
    r = runner(store, execute, speak)
    await r.tick(); await r.worker
    assert store.runs[0]['status'] == 'failed'
    assert '联网' in store.runs[0]['error']


@pytest.mark.asyncio
async def test_result_waits_for_conversation_and_can_be_stopped(store):
    item = create(store); store.clock = lambda: item['at']
    async def execute(i): return {'ok': True, 'text': 'result'}
    async def speak(t): pytest.fail('conversation is busy')
    r = runner(store, execute, speak, lambda: True)
    await r.tick()
    for _ in range(10):
        await asyncio.sleep(0)
        if store.runs[0]['status'] == 'ready': break
    assert store.runs[0]['status'] == 'ready'
    await r.stop()
    assert store.runs[0]['status'] == 'cancelled'


def test_classification_contract_and_existing_reminder_schema():
    tools = {t['name']: t for t in mcp.TOOLS}
    assert 'get_weather' in str(tools['self.task.create'])
    assert '固定' in tools['self.task.create']['description']
    assert 'self.task.create' in tools['self.alarm.create']['description']
    assert 'instruction' not in tools['self.alarm.create']['inputSchema']['properties']


@pytest.mark.asyncio
async def test_fixed_reminder_due_plays_cached_clip_without_network(tmp_path, monkeypatch):
    import test_alarms
    import numpy as np
    test_alarms.Speaker(monkeypatch)
    client = test_alarms.make_client(tmp_path, monkeypatch)
    item = client.alarms.create('reminder', '取快递', time='07:00')
    client.alarms.set_clip(item['id'], b'cached')
    async def forbidden(*args): pytest.fail('fixed reminder must not request model or TTS at due time')
    client._speech = client._execute_task = forbidden
    async def stop_no_task(): return False
    client.tasks = SimpleNamespace(stop=stop_no_task)
    seen = []
    def clip(source):
        seen.append(source)
        return [np.zeros((960, 2), np.float32)]
    client._clip_sound = clip
    await test_alarms.ring_now(client)
    assert seen and seen[0] == client.alarms.clip_path(item)
    await client.stop_alarm()

@pytest.mark.asyncio
async def test_dynamic_speech_once_and_stop_restores_volume(tmp_path, monkeypatch):
    import test_alarms
    import numpy as np
    speaker = test_alarms.Speaker(monkeypatch, 40)
    client = test_alarms.make_client(tmp_path, monkeypatch)
    client.task_speaking = False
    async def speech(text): return b'voice'
    client._speech = speech
    client._clip_sound = lambda _: [np.ones((4800, 2), np.float32) * .1]
    task = asyncio.create_task(client._speak_task('当天天气'))
    await asyncio.sleep(.05)
    assert client.task_speaking and speaker.volume == 70 and client.screen.ringing
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert speaker.volume == 40 and not client.screen.ringing and not client.task_speaking
    assert client.audio.player.buffered() < .01

@pytest.mark.asyncio
async def test_mcp_task_create_routes_tools_and_date_to_separate_store(store, monkeypatch):
    from thinksmart_client import alarms
    monkeypatch.setattr(alarms, 'clock_synced', lambda: True)
    client = SimpleNamespace(tasks=SimpleNamespace(store=store,publish=lambda:None))
    async def create_task(**args): return await app.Client.create_task(client, **args)
    client.create_task = create_task
    message = {'id': 1, 'method':'tools/call', 'params':{'name':'self.task.create','arguments':{
        'instruction':'查询执行当天优惠', 'tools':['web_search'], 'time':'09:00', 'date':'2026-12-25'}}}
    response = await mcp.handle(message, client=client)
    assert not response['result']['isError']
    assert store.items[0]['tools'] == ['web_search']
    assert '12月25日' in store.view()['items'][0]['when']

def test_write_failure_does_not_create_or_claim_work(store, monkeypatch):
    from thinksmart_client import alarms
    def failed_write(*args): raise OSError('disk full')
    with monkeypatch.context() as patch:
        patch.setattr(alarms, 'write_atomic', failed_write)
        with pytest.raises(OSError): create(store)
    assert store.items == [] and store.next_id == 1
    item = create(store)
    monkeypatch.setattr(alarms, 'write_atomic', failed_write)
    with pytest.raises(OSError): store.claim(item['at'])
    assert not store.runs and store.items[0]['at'] == item['at']

@pytest.mark.asyncio
async def test_timeout_has_visible_error_and_never_speaks(store):
    item=create(store); store.clock=lambda:item['at']
    async def execute(i): raise asyncio.TimeoutError()
    async def speak(t): pytest.fail('timed out task must not speak')
    r=runner(store,execute,speak)
    await r.tick(); await r.worker
    assert store.runs[0]['status']=='failed' and '超时' in store.runs[0]['error']


def test_speech_chunks_preserve_conditions_and_respect_tts_limit():
    text=('活动仅限指定地区学生认证，有效期内申请，普通用户不可用。'*30)
    chunks=tasks.speech_chunks(text)
    assert ''.join(chunks)==text and len(chunks)>1
    assert all(0<len(c)<=200 for c in chunks)
    assert tasks.speech_chunks('短句。')==['短句。']


@pytest.mark.asyncio
async def test_long_result_is_kept_and_spoken_instead_of_rejected(store):
    item=create(store);store.clock=lambda:item['at'];spoken=[]
    async def execute(i):return {'ok':True,'text':'说明'*200,'sources':[]}
    async def speak(text):spoken.append(text)
    r=runner(store,execute,speak);await r.tick();await r.worker
    assert store.runs[0]['status']=='completed' and spoken==['说明'*200]


@pytest.mark.asyncio
async def test_multi_segment_speech_preserves_text_and_restores_volume(tmp_path,monkeypatch):
    import test_alarms
    import numpy as np
    speaker=test_alarms.Speaker(monkeypatch,40);c=test_alarms.make_client(tmp_path,monkeypatch)
    c.task_speaking=False;seen=[]
    async def speech(text):seen.append(text);return b'voice'
    c._speech=speech;c._clip_sound=lambda _:[np.ones((960,2),np.float32)*.1]
    text='条件说明。'*100
    work=asyncio.create_task(c._speak_task(text))
    while not work.done():
        c.audio.player.pull(app.OUT_RATE)
        await asyncio.sleep(.005)
    await work
    assert ''.join(seen)==text and all(len(t)<=200 for t in seen)
    assert speaker.volume==40 and not c.task_speaking and not c.screen.ringing


@pytest.mark.asyncio
async def test_stopping_speech_also_cancels_prefetched_segment(tmp_path,monkeypatch):
    import test_alarms
    import numpy as np
    speaker=test_alarms.Speaker(monkeypatch,40);c=test_alarms.make_client(tmp_path,monkeypatch)
    c.task_speaking=False;started=asyncio.Event();closed=asyncio.Event();count=0
    async def speech(text):
        nonlocal count
        count+=1
        if count==1:return b'voice'
        started.set()
        try:await asyncio.Event().wait()
        finally:closed.set()
    c._speech=speech;c._clip_sound=lambda _:[np.ones((9600,2),np.float32)*.1]
    work=asyncio.create_task(c._speak_task('条件'*180))
    await started.wait();work.cancel()
    with pytest.raises(asyncio.CancelledError):await work
    assert closed.is_set() and speaker.volume==40 and not c.task_speaking
    assert c.audio.player.buffered()<.01
