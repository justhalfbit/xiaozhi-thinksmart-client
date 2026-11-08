"""A cached wake acknowledgement synthesized by the gateway's selected voice."""
import asyncio
import io
import logging
from pathlib import Path
import re
import time
import wave

log = logging.getLogger(__name__)


def valid_audio(audio):
    if not isinstance(audio, bytes) or not audio or len(audio) > 1_000_000:
        return False
    try:
        with wave.open(io.BytesIO(audio), 'rb') as wav:
            frames, rate, channels = wav.getnframes(), wav.getframerate(), wav.getnchannels()
            return (wav.getsampwidth() == 2 and channels in (1, 2) and 8000 <= rate <= 192000
                    and 0 < frames <= rate * 10 and len(wav.readframes(frames)) == frames * channels * 2)
    except (wave.Error, EOFError):
        return False


class WakePrompt:
    def __init__(self, fetch, apply, directory=None):
        self.fetch, self.apply = fetch, apply
        self.directory = Path(directory or Path.home() / '.cache/thinksmart-client/wake')
        self.wanted = self.loaded = None
        self.retry_at = 0
        self.task = None

    def update(self, profile):
        revision = (profile or {}).get('revision')
        if not isinstance(revision, str) or not re.fullmatch('[0-9a-f]{32}', revision):
            revision = None
        if revision != self.wanted:
            self.wanted, self.loaded, self.retry_at = revision, None, 0
            self.apply(None)  # never keep speaking the previous voice after settings change
            if revision:
                try:
                    audio = (self.directory / (revision + '.wav')).read_bytes()
                except OSError:
                    audio = None
                if valid_audio(audio):
                    self.apply(audio)
                    self.loaded = revision
        if not revision or self.loaded == revision or time.monotonic() < self.retry_at:
            return
        if self.task and not self.task.done():
            return
        self.retry_at = time.monotonic() + 60
        text = profile.get('wake_text') or '在'
        if not isinstance(text, str) or len(text) > 120:
            return
        self.task = asyncio.create_task(self._fetch(revision, text))

    async def _fetch(self, revision, text):
        try:
            audio = await self.fetch(text)
            if self.wanted != revision or not valid_audio(audio):
                return
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = self.directory / (revision + '.wav')
            tmp = path.with_suffix('.tmp')
            tmp.write_bytes(audio); tmp.chmod(0o600); tmp.replace(path)
            self.apply(audio)
            self.loaded = revision
            log.info('wake acknowledgement now uses gateway TTS profile %s', revision)
        except Exception:
            log.warning('wake acknowledgement unavailable; using the chime until retry')
