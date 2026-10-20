# Design notes (taste-skill, app screens)

Style: true-black-flat (seed 1554273). Shell: no sidebar — 48px top bar over a centred column.

## Data inventory
- Objects: films (title, duration h:mm:ss, size GB, video codec, audio codec, peak Mbps from segment sizes, status: uploading / processing n% / ready / failed),
  rooms (code, film, who is in, state playing/paused at 1:02:13), knocks (name, waiting 12 s), chat lines, the two people.
- Magnitudes: 1–20 films, 1–3 rooms, 2 people per room, 2–6 GB per film, 4–15 Mbps, 90–180 min.
- People: the admin (long session, laptop) and one friend (iPad/iPhone Safari, evening, dark room).
- Jobs: admin — upload/import a film, open a room, admit the friend. Friend — ask to join, watch. Both — play/pause/seek, talk, chat.
- Product's own things: the film itself (poster frame), the two people as two lanes, the sync drift in ms, buffered-ahead seconds.

## Screens and their one question
- Home (admin): "Is a film ready and is anyone waiting to get in?" — finding: knock waiting / processing %.
  Primary job: open a room for a ready film. Biggest block: rooms + knocks; library list beside.
- Room (watch): the film is the screen. Overlay bar: play/pause, time, scrub, chat, mic, camera, fullscreen.
- Join (friend): "Can I get in?" — name field, Ask to join, then waiting state with live status.
- Bandwidth: "Is my connection fast enough for this film?" — measured Mbps against the film's peak, prebuffer seconds.

## Face
- Data hue from the product's world: projector-lamp amber #f2b33d (replaces dealt lime). Only on data: progress, buffered range, the playhead, sync OK.
  Positive stays a separate green-free signal: sync state uses the hue; warnings use the pill pair only.
- Ground: studied #000 for media.

## Signature element
- The sync strip: the two people as two lanes along the film's timeline — each lane shows that person's buffered range and playhead,
  with the drift in ms at the end ("Meera · +18 ms"). Lives under the scrub bar in the overlay (and on the room card on Home).
