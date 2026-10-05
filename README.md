# Pico

A desktop coding agent for macOS.

[Website](https://nvms.github.io/pico/) | [Download for Mac](https://github.com/nvms/pico-releases/releases/latest)

![Pico desktop application](landing/ss_1_dark.png)

This repository contains Pico's [agent runtime](packages/core) and website. The terminal client lives in `packages/pico`.

## Terminal client installation

```sh
npm install --global picocode
```

### Session messaging

In an interactive session, `/rename foo` enables local peer messaging. Only explicitly named, connected sessions can discover and message one another, across projects under the same local user account. The agent uses `peer_list` and `peer_send`; replies arrive automatically. Messages sent and received appear in full as distinct colored transcript entries.

Names are unique among connected sessions. A conflicting rename leaves the current name unchanged; a resumed session with a conflicting name stays disconnected until renamed. `/rename` without a name disconnects, and `/fork` copies the conversation without its custom name. Messages received during a turn are processed after the next tool call, or when the turn ends, while respecting pause. Interrupting pauses automatic peer responses until you send another message. Named interactive sessions stay running when you switch sessions or close the terminal. Pico manages their background process automatically; it does not restart work after a crash. Unnamed sessions stop when their last terminal view closes. Offline delivery is not supported. A delivery receipt confirms persistence, not task completion. A timed-out send has unknown delivery status and is not automatically retried. Peer input is labeled as collaborator input, not user or system instructions. Socket access is restricted to the local operating-system account; it does not isolate mutually untrusted processes running under that same account. Unsaved ephemeral sessions cannot enable messaging.

### Live sessions

Left arrow from an empty chat composer opens the named-session sidebar. Navigate with arrows, J/K, Ctrl+D/U, or g/G. Right arrow or L enters the selected session; Escape returns to the current conversation. Activity descriptions update live. Ctrl+X interrupts a working session; on an idle session it clears the name and removes it from the sidebar. A demoted session remains alive while a terminal is viewing it. Multiple terminals attached to a session share one execution owner and conversation.

### Codex Fast mode

For Codex subscription models that advertise Fast support, `/speed` selects Standard or Fast independently of thinking effort. `/speed fast` and `/speed standard` apply directly. In the picker, Enter applies to the session; Ctrl+S also saves the default for that model. Session speed survives resume and fork.

Fast requests use `priority` and consume included subscription usage at 2.5x the Standard rate. The Fast label shows the requested setting, not a guarantee of delivered speed. Background workers and deliberation participants remain Standard. `--speed standard|fast` is also available for interactive, headless, and shell requests; shell requests use Standard unless explicitly overridden.

### Shell command generation

`pico --shell "zip the images in this folder"` prints one command without running it. To bind Ctrl-] in zsh, add this line to `.zshrc`:

```zsh
source "${commands[pico]:A:h:h}/integrations/pico.zsh"
```

Choose the Shell model in Pico's `/config` screen. `--model` overrides it for one request.

### Local dictation

In the composer, Ctrl+G starts recording, Enter stops and inserts the transcript at the cursor, and Escape cancels. Dictation never sends a message automatically or sends microphone audio to a cloud service.

**macOS:** requires macOS 14 or newer on Apple Silicon. macOS asks for microphone access on first use, and FluidAudio downloads the Parakeet speech models to the user's cache. For a source checkout, run `make helper` and `make build`.

**Linux:** uses whisper.cpp for CPU transcription and `pw-record` (PipeWire), or `parec` (PulseAudio), for microphone capture. From a source checkout:

```sh
# Ubuntu/Debian prerequisites
sudo apt install build-essential cmake curl git pipewire-bin
make helper-linux
make build
```

`make helper-linux` builds whisper.cpp v1.8.2 and downloads the English base model (~148 MB) to `${XDG_CACHE_HOME:-~/.cache}/pico/whisper`. After setup, dictation works offline. Recordings are limited to two minutes; temporary audio is removed after transcription or cancellation. Linux does not mute speaker output, so headphones are recommended.

To use your own installation, set `PICO_WHISPER_BIN` to a whisper.cpp `whisper-cli` executable and `PICO_WHISPER_MODEL` to a GGML model file. The helper also searches `PATH` for `whisper-cli`. `PICO_WHISPER_LANGUAGE` defaults to `en`; use a multilingual model for other languages. `PICO_DICTATION_SOURCE` selects a PipeWire target or PulseAudio source; otherwise the default microphone is used.

### Region screenshots

Click the square beside the record button, or press Ctrl+O, then drag a screen region to attach it to the composer. This does not send the message automatically. macOS uses its built-in screenshot tool. Linux X11 uses `xfce4-screenshooter`, with `gnome-screenshot` and `scrot` as fallbacks; on Ubuntu/Debian, install it with `sudo apt install xfce4-screenshooter`. Wayland tries `gnome-screenshot` or `spectacle`, whose capture support depends on the compositor; there is not yet a universal portal backend.
