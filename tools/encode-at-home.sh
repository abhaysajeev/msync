#!/usr/bin/env bash
# Re-encode a film that browsers cannot play (AV1, VC-1, 10-bit H.264, ...) on your own,
# faster computer before uploading, instead of on the 2-vCPU VPS.
#
#   tools/encode-at-home.sh input.mkv [crf=20] [preset=slow]
#
# Output: input.web.mp4 — H.264 High 8-bit + AAC stereo, keyframes every 6 s to match the
# server's HLS segments, faststart. CRF 18-22 is visually near-transparent for 1080p.
# Text subtitles are kept as mov_text; the server turns them into WebVTT. If the file only
# has picture subtitles (PGS/VobSub), ffmpeg refuses them: replace -map "0:s?" -c:s mov_text with -sn.
set -euo pipefail
IN="$1"
CRF="${2:-20}"
PRESET="${3:-slow}"
OUT="${IN%.*}.web.mp4"
ffmpeg -hide_banner -i "$IN" \
  -map 0:v:0 -map 0:a:0 -map "0:s?" \
  -c:v libx264 -preset "$PRESET" -crf "$CRF" -pix_fmt yuv420p -profile:v high -level:v 4.1 \
  -force_key_frames "expr:gte(t,n_forced*6)" \
  -c:a aac -b:a 192k -ac 2 \
  -c:s mov_text \
  -movflags +faststart "$OUT"
echo "wrote $OUT — upload it from the host page"
