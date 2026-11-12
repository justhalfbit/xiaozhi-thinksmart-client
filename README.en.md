# xiaozhi-thinksmart-client

Voice client for the Lenovo ThinkSmart View (CD-18781Y): on-device wake word “Xiaomai Xiaomai”, echo cancellation, Xiaozhi protocol to [xiaozhi-hub-server](https://github.com/justhalfbit/xiaozhi-hub-server), and a kiosk chat UI on `127.0.0.1:8090`.

This is part of [thinksmart-ubuntu-image](https://github.com/justhalfbit/thinksmart-ubuntu-image). Flash and install from that README. Installed devices update from this repo’s Releases via Settings → Software update (system-layer packages live in the same Releases and install with the client; the flash image itself stays in the image repo).

English UI strings live in `web/` (this branch). Wake phrase stays “Xiaomai Xiaomai” (小麦小麦). MCP tool descriptions for the Chinese LLM are unchanged.

## Layout

| Path | Role |
| --- | --- |
| `thinksmart_client/app.py` | State machine: wake → listen → reply → 10 s follow-up → idle; barge-in, hold-to-talk, text questions, per-model history |
| `tests/` | Unit tests (no device audio); see file headers |
| `thinksmart_client/audio.py` | Mic 16 kHz, speaker 48 kHz via PipeWire; AEC only during talk or just after playback |
| `thinksmart_client/aec.py` | WebRTC APM AEC (from py-xiaozhi AecEngine) |
| `thinksmart_client/kws.py` | sherpa-onnx wake word, 40 ms batches, skip while quiet |
| `thinksmart_client/wake_verify.py` | Optional hub ASR confirm (`wake_verify: 'hub'`) |
| `eval/wake/` | Wake eval |
| `thinksmart_client/hub.py` | Xiaozhi WebSocket (`hello` declares `mcp` only) |
| `thinksmart_client/mcp.py` | Device tools: volume, sleep hours, brightness, timers/alarms/reminders, alarm volume |
| `thinksmart_client/alarms.py` | Timers, alarms, reminders (daily / weekdays / weekly / monthly) |
| `thinksmart_client/device.py` | Screen, keys, brightness, auto-off |
| `thinksmart_client/sleep.py` | Sleep hours (may span midnight) |
| `thinksmart_client/bt.py`, `bt_helper.py` | Bluetooth speaker path |
| `thinksmart_client/opus.py` | libopus ctypes |
| `thinksmart_client/web.py` | Pages, SSE, button APIs |
| `web/` | UI: live `v2/` (`/` and `/v2`); v1 at `/v1` |
| `models/kws-zh/` | Wake-word model |
| `deploy/thinksmart-client.service` | systemd unit |
| `deploy/bootstrap-updater` | Root pre-start updater bootstrap |

## APIs (localhost only)

Same routes as [README.md](README.md). User-visible copy in the kiosk is English on this branch.

## License

MIT, see [LICENSE](LICENSE). Vendor logos are trademarks of their owners. Personal project, not affiliated with Lenovo or the model vendors.
