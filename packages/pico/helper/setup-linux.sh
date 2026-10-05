#!/usr/bin/env bash
set -euo pipefail

# Keep build artifacts and model weights out of the Pico checkout.
cache="${XDG_CACHE_HOME:-$HOME/.cache}/pico/whisper"
version=v1.8.2
for tool in git cmake make c++ curl; do
  if ! command -v "$tool" >/dev/null; then
    echo "Missing $tool. On Ubuntu/Debian: sudo apt install build-essential cmake curl git" >&2
    exit 1
  fi
done
if ! command -v pw-record >/dev/null && ! command -v parec >/dev/null; then
  echo 'Install a recorder: sudo apt install pipewire-bin (or pulseaudio-utils).' >&2
  exit 1
fi
mkdir -p "$cache"
source_dir="$cache/whisper.cpp-$version"
if [[ ! -d "$source_dir" ]]; then
  git clone --depth 1 --branch "$version" https://github.com/ggml-org/whisper.cpp.git "$source_dir"
fi
cmake -S "$source_dir" -B "$source_dir/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_CURL=OFF
cmake --build "$source_dir/build" --config Release --target whisper-cli -j "$(getconf _NPROCESSORS_ONLN)"
# Install atomically so an interrupted rebuild cannot corrupt the working helper.
cp "$source_dir/build/bin/whisper-cli" "$cache/whisper-cli.new"
chmod 755 "$cache/whisper-cli.new"
mv "$cache/whisper-cli.new" "$cache/whisper-cli"
model="$cache/ggml-base.en.bin"
if [[ ! -s "$model" ]]; then
  curl --fail --location --retry 3 --output "$model.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  mv "$model.part" "$model"
fi
printf '\nLinux dictation is ready. Ctrl-G records, Enter transcribes, Escape cancels.\n'
