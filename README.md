# sesame-pet

A pet personality for the [Sesame robot](https://github.com/dorianborian/sesame-robot): you talk to it from your phone, and it answers with moves, faces and creature noises (chirps, trills, purrs, hisses) — never words. A browser simulator runs the **same firmware code** you flash, so everything can be built and tuned before the hardware exists.

```
phone (mic, speaker) ──wss──► hub (laptop / bolthub-server) ──► gpt-realtime (via CLIProxyAPI)
                                  │  act(steps) ◄────────────────┘
                                  ├──HTTP /api/command──► robot  (or the simulator: same API)
                                  └◄─UDP sound events──── robot  (playSound in firmware)
```

## Setup

The firmware and the printed parts live in your clone of `sesame-robot`, on the `pet` branch, next to this repo:

```
codebase/
  sesame-robot/   <- firmware you flash + STLs (branch: pet)
  sesame-pet/     <- this repo: hub, simulator, phone page, pet personality
```

(Set `SESAME_ROBOT_DIR` in `.env` if it lives elsewhere.) Pull Dorian's updates with `git -C ../sesame-robot pull origin main` while on `pet` — a normal git merge.

## Run

```bash
npm install
cp .env.example .env      # put the proxy key in OPENAI_API_KEY
npm start                 # simulator
npm start -- --robot http://192.168.1.50   # the real robot (the simulator becomes its 3D twin)
npm test
```

- **Phone:** `https://<laptop-ip>:8443/` — accept the certificate warning once (the mic only works on https). Tap the button and talk.
- **Lab (laptop):** `http://localhost:8000/lab` — moves, faces, sound designer, servo sliders, typed chat with the AI, logs.
- **Simulated robot:** `http://localhost:8080/` — the robot's own web controller, served from `captive-portal.h`.

## One source of truth

| You edit | What updates |
|---|---|
| `sesame-robot/firmware/movement-sequences.h` (moves, timings, `playSound` cues) | Simulator runs the new code on save; flash the same file to the robot |
| `sesame-robot/firmware/sesame-firmware-main.ino` dispatch in `loop()` | New commands appear in the Lab and become available to the AI automatically |
| `sesame-robot/firmware/face-bitmaps.h` | Faces in the simulator and the Lab |
| `pet/behaviors.json` | What the AI can do (applies mid-call) |
| `pet/sounds.json` | The creature sounds (Lab → Sounds to tweak; Download WAV for a future robot speaker) |
| `pet/personality.md` | How the AI decides |

How: `server/firmware/` transpiles the firmware's C (moves + the `loop()` command table) to JavaScript and runs it against a stand-in for the hardware. Only the hardware helpers are reimplemented, mirroring the `.ino`: `setServoAngle`, `setFace*`, `delayWithFace`, `pressingCheck`, idle blink, face animation and the HTTP API. If the firmware stops parsing, the simulator says where (`file:line`) and keeps the last good version.

Write new moves in `movement-sequences.h` using the same helpers as the existing ones, and add a line to the dispatch in `loop()`.

## Firmware changes vs upstream

The `pet` branch of `sesame-robot` is upstream `main` plus (see `git log main..pet`):

- `playSound(name)`: sends the sound name over UDP port 4210 to whoever last called the JSON API (the hub), which plays it on the phone. A speaker on the robot can hook in here later.
- `/api/command` accepts a `"sound"` field (alone, or with `face`/`command`).
- `playSound` cues in the moves (chirps while waving, ticks on each step, a yawn on rest…).

Flash it exactly as the upstream firmware README describes (Lolin S2 Mini, ESP32Servo 3.0.9). For voice control, put the robot on your WiFi (`NETWORK_SSID` or its web Settings) and start the hub with `--robot http://<robot-ip>`.

## Credits

Firmware, STLs: [dorianborian/sesame-robot](https://github.com/dorianborian/sesame-robot). Joint calibration (`rig/joints_config.json`): [dorianborian/sesame-studio](https://github.com/dorianborian/sesame-studio). Both Apache-2.0.
