import asyncio
import io
import wave

from thinksmart_client.wake_prompt import WakePrompt, valid_audio


def wav(value=1):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(bytes([value, 0]) * 2400)
    return buffer.getvalue()


def test_generated_prompt_survives_restart_without_another_paid_request(tmp_path):
    async def run():
        calls, applied = [], []
        async def fetch(text):
            calls.append(text); return wav()
        profile = {'revision': 'a' * 32}
        prompt = WakePrompt(fetch, applied.append, tmp_path)
        prompt.update(profile); await prompt.task
        assert calls == ['在'] and applied == [None, wav()]
        prompt.update(profile)
        restarted = WakePrompt(fetch, applied.append, tmp_path)
        restarted.update(profile)
        assert calls == ['在'] and restarted.loaded == 'a' * 32 and restarted.task is None
    asyncio.run(run())


def test_voice_change_drops_old_prompt_and_discards_late_old_response(tmp_path):
    async def run():
        applied = []; release = asyncio.Event()
        async def fetch(text):
            await release.wait(); return wav()
        prompt = WakePrompt(fetch, applied.append, tmp_path)
        prompt.update({'revision': 'a' * 32})
        first = prompt.task
        prompt.update({'revision': 'b' * 32})
        assert applied == [None, None]
        release.set(); await first
        assert prompt.loaded is None and not (tmp_path / ('a' * 32 + '.wav')).exists()
        prompt.update({'revision': 'b' * 32}); await prompt.task
        assert prompt.loaded == 'b' * 32 and applied[-1] == wav()
    asyncio.run(run())


def test_failure_uses_chime_and_backs_off(tmp_path):
    async def run():
        calls, applied = [], []
        async def fetch(text):
            calls.append(text); return b'not-a-wav'
        prompt = WakePrompt(fetch, applied.append, tmp_path)
        prompt.update({'revision': 'a' * 32}); await prompt.task
        for _ in range(5):
            prompt.update({'revision': 'a' * 32})
        assert calls == ['在'] and applied == [None] and prompt.loaded is None
        prompt.update(None)
        prompt.update({'revision': '../../untrusted'})
        assert prompt.wanted is None
    asyncio.run(run())


def test_truncated_or_invalid_audio_is_not_used():
    assert valid_audio(wav())
    assert not valid_audio(wav()[:50])
    assert not valid_audio(b'') and not valid_audio(None)


def test_gateway_supplies_the_selected_languages_wake_text(tmp_path):
    async def run():
        calls = []
        async def fetch(text):
            calls.append(text); return wav()
        prompt = WakePrompt(fetch, lambda audio: None, tmp_path)
        prompt.update({'revision': 'a' * 32, 'wake_text': '喺度'}); await prompt.task
        prompt.update({'revision': 'b' * 32, 'wake_text': "I'm here."}); await prompt.task
        assert calls == ['喺度', "I'm here."]
    asyncio.run(run())
