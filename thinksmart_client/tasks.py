"""Durable dynamic tasks, separate from offline alarms. One execution per scheduled occurrence."""
import asyncio
import datetime as dt
import json
import logging
import pathlib
import time
import uuid

from . import alarms

OPEN = {'running', 'ready', 'speaking'}
TOOLS = {'get_weather', 'web_search'}
MAX_RUNS = 50
MAX_TEXT = 1200


def speech_chunks(text, limit=200):
    """Preserve every character, preferring sentence boundaries for the TTS request limit."""
    chunks = []
    while text:
        end = min(len(text), limit)
        if end < len(text):
            boundary = max(text.rfind(p, 0, end) for p in '。！？；\n')
            if boundary >= limit // 2:
                end = boundary + 1
        chunks.append(text[:end])
        text = text[end:]
    return chunks


class Store:
    def __init__(self, directory=None, clock=time.time):
        self.path = pathlib.Path(directory or alarms.DIR.parent) / 'tasks.json'
        self.clock = clock
        self.items, self.runs, self.next_id = [], [], 1
        self.error = None
        try:
            data = json.loads(self.path.read_text())
            self.items = data['items']
            self.runs = data['runs']
            self.next_id = int(data['next_id'])
            if not isinstance(self.items, list) or not isinstance(self.runs, list): raise ValueError()
            if any(not isinstance(i, dict) or not {'id', 'repeat', 'instruction', 'tools', 'label', 'at'} <= i.keys()
                   for i in self.items): raise ValueError()
            if any(not isinstance(r, dict) or not {'id', 'task_id', 'status'} <= r.keys()
                   for r in self.runs): raise ValueError()
        except FileNotFoundError:
            pass
        except (ValueError, TypeError, KeyError, OSError):
            # Do not silently replace an unreadable task database.
            self.items, self.runs, self.next_id = [], [], 1
            self.error = '动态任务文件无法读取，请先保留文件并检查'
        changed = False
        for run in self.runs:
            if run['status'] in OPEN:
                run.update(status='interrupted', error='设备重启，本次未自动重跑', finished_at=self.clock())
                changed = True
        if changed:
            try: self.save()
            except OSError: self.error = '动态任务状态无法保存，请检查可用空间及文件权限'

    def save(self):
        terminal = [r for r in self.runs if r['status'] not in OPEN][-MAX_RUNS:]
        runs = terminal + [r for r in self.runs if r['status'] in OPEN]
        alarms.write_atomic(self.path, json.dumps({'version': 1, 'next_id': self.next_id,
                            'items': self.items, 'runs': runs}, ensure_ascii=False).encode())
        self.runs = runs

    def create(self, instruction, label='', tools=None, repeat=None, **when):
        if self.error: raise ValueError(self.error)
        if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= 1000:
            raise ValueError('动态任务需要 1–1000 字的执行指令')
        tools = [] if tools is None else tools
        if not isinstance(tools, list) or len(tools) > 2 or any(not isinstance(t, str) or t not in TOOLS for t in tools):
            raise ValueError('只支持 get_weather、web_search 查询工具')
        if len(self.items) >= 100: raise ValueError('最多保存 100 项动态任务，请先删除一些')
        rule = alarms.normalize_repeat(repeat)
        at = alarms.plan(self.clock(), repeat=rule, **when)
        item = {'id': self.next_id, 'label': str(label or '动态任务')[:60], 'instruction': instruction.strip(),
                'tools': list(dict.fromkeys(tools)), 'repeat': rule, 'at': at,
                'time': dt.datetime.fromtimestamp(at).strftime('%H:%M') if rule else None, 'created': self.clock()}
        self.next_id += 1
        self.items.append(item)
        try:
            self.save()
        except OSError:
            self.items.remove(item)
            self.next_id -= 1
            raise
        return self.view_item(item)

    def view_item(self, item):
        at = item.get('at')
        return {**item, 'when': alarms.describe_when(at, self.clock()) if at else '已结束',
                'repeat_text': alarms.describe_repeat(item['repeat']), 'type': '动态任务'}

    def view(self):
        return {'items': [self.view_item(i) for i in self.items], 'runs': list(reversed(self.runs)), 'error': self.error}

    def claim(self, now):
        if self.error: return None
        for item in sorted(self.items, key=lambda i: i.get('at') if i.get('at') is not None else float('inf')):
            at = item.get('at')
            if at is None or at > now or any(r['task_id'] == item['id'] and r['status'] in OPEN for r in self.runs):
                continue
            item['at'] = (alarms.next_time(item['repeat'], item['time'], dt.datetime.fromtimestamp(now)).timestamp()
                          if item['repeat'] else None)
            run = {'id': uuid.uuid4().hex, 'task_id': item['id'], 'label': item['label'], 'scheduled_at': at,
                   'started_at': now, 'status': 'running' if now - at <= alarms.CATCH_UP else 'missed',
                   'text': '', 'sources': [], 'error': ''}
            self.runs.append(run)
            try:
                self.save()  # advance + claim are one durable write, before network traffic
            except OSError:
                item['at'] = at
                self.runs.remove(run)
                raise
            return item.copy(), run
        return None

    def update(self, run, status, **fields):
        run.update(status=status, **fields)
        if status not in OPEN: run['finished_at'] = self.clock()
        self.save()

    def remove(self, item_id):
        if self.error: raise ValueError(self.error)
        previous = self.items
        before = len(previous)
        self.items = [i for i in self.items if i['id'] != item_id]
        try:
            self.save()
        except OSError:
            self.items = previous
            raise
        return before != len(self.items)


class Runner:
    def __init__(self, store, execute, speak, busy, changed, synced=alarms.clock_synced, cancel=None):
        self.store, self.execute, self.speak = store, execute, speak
        self.busy, self.changed, self.synced = busy, changed, synced
        self.worker = self.current = None
        self.cancel = cancel

    def publish(self):
        self.changed(self.store.view())

    async def loop(self):
        while True:
            try:
                await self.tick()
            except Exception:
                logging.getLogger(__name__).exception('dynamic task scheduler')
            await asyncio.sleep(1)

    async def tick(self):
        if self.worker and not self.worker.done() or not self.synced(): return
        claimed = self.store.claim(self.store.clock())
        if not claimed: return
        item, run = claimed
        self.publish()
        if run['status'] == 'missed': return
        self.current = run
        self.worker = asyncio.create_task(self.perform(item, run))

    async def perform(self, item, run):
        try:
            result = await asyncio.wait_for(self.execute({**item, 'run_id': run['id']}), 125)
            if not isinstance(result, dict) or not result.get('ok'):
                raise ValueError(result.get('error', '任务执行失败') if isinstance(result, dict) else '任务执行失败')
            text = result.get('text')
            if not isinstance(text, str) or not 1 <= len(text) <= MAX_TEXT: raise ValueError('任务结果格式不正确')
            self.store.update(run, 'ready', text=text, sources=result.get('sources') or [])
            self.publish()
            deadline = time.monotonic() + 600
            while self.busy():
                if time.monotonic() >= deadline: raise ValueError('等待播报超过十分钟，本次已跳过')
                await asyncio.sleep(.2)
            self.store.update(run, 'speaking')
            self.publish()
            await self.speak(text)
            self.store.update(run, 'completed')
        except asyncio.CancelledError:
            self.store.update(run, 'cancelled', error='本次已停止')
            if self.cancel:
                try:
                    await asyncio.wait_for(self.cancel(run['id']), 3)
                except Exception:
                    pass  # gateway's own 120s deadline still bounds a disconnected request
        except asyncio.TimeoutError:
            self.store.update(run, 'failed', error='本次任务执行超时，未播报结果')
        except Exception as e:
            self.store.update(run, 'failed', error=str(e)[:200])
        finally:
            self.current = None
            self.publish()

    async def stop(self, item_id=None):
        if self.current is None or item_id is not None and self.current['task_id'] != item_id: return False
        run = self.current
        self.worker.cancel()
        try:
            await self.worker
        except asyncio.CancelledError:
            # The task may be cancelled before its coroutine has even started.
            if run['status'] in OPEN:
                self.store.update(run, 'cancelled', error='本次已停止')
            self.current = None
            self.publish()
        return True

    async def remove(self, item_id):
        await self.stop(item_id)
        found = self.store.remove(item_id)
        self.publish()
        return found
