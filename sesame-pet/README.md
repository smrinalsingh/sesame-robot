# sesame-pet

A pet personality for the [Sesame robot](https://github.com/dorianborian/sesame-robot): you talk to it from your phone, and it answers with moves, faces and a short line of its own — either as creature noises (chirps, trills, purrs, hisses) with the line as a caption, or spoken out loud. You pick with the **Noises / Words** switch. A browser simulator runs the **same firmware code** you flash, so everything can be built and tuned before the hardware exists.

```
phone (mic, speaker) ──wss──► hub (laptop / bolthub-server) ──► gpt-realtime (via CLIProxyAPI)
                                  │  act(steps) ◄────────────────┘
                                  ├──HTTP /api/command──► robot  (or the simulator: same API)
                                  └◄─UDP sound events──── robot  (playSound in firmware)
```

## Setup

This folder lives on the `pet` branch of [smrinalsingh/sesame-robot](https://github.com/smrinalsingh/sesame-robot), a fork of Dorian's repo:

```
sesame-robot/        <- branch: pet
  firmware/          <- what you flash (+ our sound hook); the simulator runs this
  hardware/          <- STLs; the 3D view uses these
  sesame-pet/        <- this app: hub, simulator, phone page, pet personality
```

Get Dorian's updates with `git pull origin main` (on `pet`); back up with `git push` (to the fork).

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
| `pet/voice.json` | Noises or words (the switch saves here), which voice, and how it acts its lines |
| `pet/personality.md` | How the AI decides |

How: `server/firmware/` transpiles the firmware's C (moves + the `loop()` command table) to JavaScript and runs it against a stand-in for the hardware. Only the hardware helpers are reimplemented, mirroring the `.ino`: `setServoAngle`, `setFace*`, `delayWithFace`, `pressingCheck`, idle blink, face animation and the HTTP API. If the firmware stops parsing, the simulator says where (`file:line`) and keeps the last good version.

Write new moves in `movement-sequences.h` using the same helpers as the existing ones, and add a line to the dispatch in `loop()`.

## Noises or words

Every reaction from the AI is one `act` call with `say` (a short line, always there) and the behaviors. The switch only changes how you hear it:

- **Noises:** pet sounds play; the line is shown as a caption.
- **Words:** the line is spoken word for word while the robot moves; pet sounds are muted.

The voice is a gpt-realtime voice turned into a critter's: realtime has no pitch control, so it is asked to talk slower (its `speed` setting) and the hub then resamples it higher (`server/pet/voicefx.js`). That raises pitch and "throat size" together and brings the pace back, plus a slight warble. Tune pitch, pace, wobble, base voice and acting in **Lab → Voice** (with a Try button); it saves to `pet/voice.json`. The voice has its own realtime connection (`server/pet/speaker.js`), separate from the call.

The phone mutes its mic while Sesame is making a sound or talking, so it doesn't hear itself. Speech arrives at the hub as 24 kHz audio and is sent on to the pages; a speaker on the robot can later take the same stream.

## Firmware changes vs upstream

The `pet` branch of `sesame-robot` is upstream `main` plus (see `git log main..pet`):

- `playSound(name)`: sends the sound name over UDP port 4210 to whoever last called the JSON API (the hub), which plays it on the phone. A speaker on the robot can hook in here later.
- `/api/command` accepts a `"sound"` field (alone, or with `face`/`command`).
- `playSound` cues in the moves (chirps while waving, ticks on each step, a yawn on rest…).

Flash it exactly as the upstream firmware README describes (Lolin S2 Mini, ESP32Servo 3.0.9). For voice control, put the robot on your WiFi (`NETWORK_SSID` or its web Settings) and start the hub with `--robot http://<robot-ip>`.

## Credits

Firmware, STLs: [dorianborian/sesame-robot](https://github.com/dorianborian/sesame-robot). Joint calibration (`rig/joints_config.json`): [dorianborian/sesame-studio](https://github.com/dorianborian/sesame-studio). Both Apache-2.0.
