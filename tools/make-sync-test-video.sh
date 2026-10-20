#!/usr/bin/env bash
# A film for measuring sync by eye and by ear: big running timecode + frame number, a white
# flash and a 1 kHz beep at the top of every second. Put two devices side by side, film them
# in slow motion (240 fps) and compare the timecodes / flashes to read the real drift in ms.
#
#   tools/make-sync-test-video.sh [minutes=10] [out=sync-test.mp4]
# Uses local ffmpeg, or the msync-api Docker image when ffmpeg is not installed.
set -euo pipefail
MIN="${1:-10}"
OUT="${2:-sync-test.mp4}"
SECS=$((MIN * 60))
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

VF="drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t\,1)\,0.1)',\
drawtext=fontfile=$FONT:text='%{pts\:hms}':fontsize=150:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=24:x=(w-tw)/2:y=(h-th)/2-110,\
drawtext=fontfile=$FONT:text='frame %{n}':fontsize=80:fontcolor=0xf2b33d:box=1:boxcolor=black@0.7:boxborderw=16:x=(w-tw)/2:y=(h-th)/2+120"

run() {
  if command -v ffmpeg >/dev/null 2>&1 && [ -f "$FONT" ]; then
    ffmpeg "$@"
  else
    docker run --rm -v "$PWD:/work" -w /work --entrypoint ffmpeg msync-api "$@"
  fi
}

run -hide_banner -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=$SECS" \
  -f lavfi -i "aevalsrc='if(lt(mod(t\,1)\,0.1)\, 0.5*sin(2*PI*1000*t)\, 0)':s=48000:d=$SECS" \
  -vf "$VF" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -g 48 \
  -c:a aac -b:a 128k -ac 2 -movflags +faststart -shortest "$OUT"
echo "wrote $OUT"
