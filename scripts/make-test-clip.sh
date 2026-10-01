#!/usr/bin/env sh
# Regenerates app/src/main/assets/test-clip.mp4: FFmpeg's built-in test pattern (colour bars and
# a running counter), 6 s, 640x360, H.264 baseline, no audio. Synthetic, so it carries no one's
# footage and no licence beyond FFmpeg's own output.
set -e
cd "$(dirname "$0")/.."
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=640x360:rate=30:duration=6" \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -crf 30 -movflags +faststart -an \
  app/src/main/assets/test-clip.mp4
ls -l app/src/main/assets/test-clip.mp4
