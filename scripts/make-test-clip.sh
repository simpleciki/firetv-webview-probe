#!/usr/bin/env sh
# Regenerates the probe's two synthetic clips from FFmpeg's built-in test pattern (colour bars and
# a running counter). Synthetic, so they carry no one's footage and no licence beyond FFmpeg's own output.
#   test-clip.mp4   6 s, 640x360, H.264 baseline, no audio: the video-visibility steps.
#   voice-clip.mp4  60 s, same picture plus a silent AAC track: the voice steps on Vega OS, where the
#                   page's own video is the media Alexa acts on. Media controls can ignore a player with
#                   no audio track, so this one has one; it is long enough that no step needs to loop it.
set -e
cd "$(dirname "$0")/.."
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=640x360:rate=30:duration=6" \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -crf 30 -movflags +faststart -an \
  app/src/main/assets/test-clip.mp4
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=640x360:rate=30:duration=60" \
  -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100" -shortest \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -crf 32 -c:a aac -b:a 32k -movflags +faststart \
  app/src/main/assets/voice-clip.mp4
ls -l app/src/main/assets/test-clip.mp4 app/src/main/assets/voice-clip.mp4
