# Spotify on mobile web

The goal: sign in to Spotify on the phone, pick a playlist, hear it, and see it visualised.

## Verdict

That exact shape is not achievable, for two independent reasons — either one alone is fatal.

1. **Spotify's Web Playback SDK is not supported in mobile browsers.** It is a desktop-browser SDK. On a phone there is nothing to play Spotify audio *inside* the page.
2. **Even on desktop, its audio cannot be analysed.** The SDK decodes through EME. The browser is not permitted to hand DRM-protected samples to Web Audio; `createMediaElementSource` on it yields silence, not quiet audio. This is a platform guarantee, not a gap to engineer around.

So "Spotify audio, playing in a mobile web page, analysed in real time" has no route. Everything below is a way of getting close, not a way around this.

Both claims are stated from knowledge and should be confirmed against the current SDK docs before anyone builds on them. See [Verifying](#verifying).

## The options

| | Loopback | Spotify Connect + precomputed analysis | Open/direct audio sources | Local files |
| --- | --- | --- | --- | --- |
| What drives the visuals | real audio | Spotify's precomputed timeline | real audio | real audio |
| Key / mode | live | per track, from Spotify | live | live |
| Tempo, beats | live | Spotify's, better than mine | live | live |
| The breath | yes | only from section data | yes | yes |
| Voice separation | yes | no | yes | yes |
| Struck vs held | yes | roughly, from timbre vectors | yes | yes |
| Your Spotify library | yes | yes | no | no |
| Works on a phone | no | yes | yes | yes |
| Setup | one-time, desktop | OAuth + app registration | none | none |
| Risk it does not work | none | high, see below | low | none |

### Loopback

Route system audio into a virtual device (BlackHole, free) and select it in the input picker. Anything the machine plays is then analysed for real, Spotify included, with the entire engine working unchanged.

Desktop only, so it does not serve the stated goal, but it is the only option that gives both your Spotify library and real analysis. Two practical annoyances: the system volume keys do not control a Multi-Output Device properly, so you set volume in Spotify itself; and you have to remember to switch the output back afterwards.

### Spotify Connect plus precomputed analysis

The phone's Spotify app plays. The web page authenticates, polls `/v1/me/player` for the current track and `progress_ms`, and drives the visuals from `/v1/audio-analysis/{id}` — which gives beats, bars, sections, and per-segment 12-dimensional pitch and timbre vectors.

This is the closest thing to the stated goal that can exist: you sign in on the phone, pick a playlist, hear it, and see something genuinely synchronised to it.

Two serious caveats.

**It may simply be unavailable.** `/v1/audio-features` and `/v1/audio-analysis` were, to my knowledge, deprecated for *new* applications around November 2024 — existing apps kept access, newly registered client IDs receive 403. If that is still the case, this option collapses to "track name and artwork". This is the single most important thing to check and it takes two minutes.

**It is a different piece.** Nothing in `src/analysis.js` would run. The breath, the centre-versus-side vocal isolation, struck-versus-held, the live pitch detection — none of it applies to a precomputed timeline. You would be building a second, simpler visualiser driven by a beat grid, and most of what makes this one interesting would sit unused. It would be better at rhythm and worse at everything else.

Sync is workable: poll `/v1/me/player` every few seconds, interpolate `progress_ms` against a local clock between polls, and resynchronise on drift. Expect tens of milliseconds of error, which is fine for visuals and not good enough for anything tighter.

### Open and direct audio sources

Anything served as plain audio with permissive CORS can be played through an `<audio>` element, passed to `createMediaElementSource`, and analysed exactly as the bundled track is. That includes Audius, Jamendo, the Internet Archive, Free Music Archive and podcast RSS enclosures. Works on iOS Safari, needs no setup, and the whole engine applies.

It is not your Spotify library, which may make it irrelevant to you. But if the real goal is "a playlist plays in the background and the visuals respond properly", this is the only option that delivers that on a phone.

### Local files

The mobile file picker reaches the Files app and iCloud Drive. Multi-select gives a queue. Zero setup, full analysis, works today. Same caveat: your files, not your Spotify library.

## Recommendation

There are two honest answers depending on which half of the goal matters more.

**If it must be your Spotify library:** loopback on the desktop, and accept that the phone is out of scope. It is the only way to get both the library and real analysis, and the whole engine keeps working.

**If it must be the phone:** a queue from open sources or local files. Everything works, nothing needs verifying, and it can be built now.

I would not start on the Spotify Connect route until the deprecation question is settled, because if the analysis endpoints are gone it degrades to a "now playing" label, and even if they are available it means writing a second visualiser that bypasses everything this one does well.

## Verifying

Three facts above are worth confirming rather than trusting. Each is quick.

**1. Is the Web Playback SDK really desktop-only?** Check the SDK's stated browser support in Spotify's developer docs.

**2. Are the analysis endpoints available to a new app?** Register an application, get a token, then:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  https://api.spotify.com/v1/audio-analysis/11dFghVXANMlKmJXsNCbNl
```

`200` means the Connect route is viable. `403` means it is not, and that option is dead.

**3. Is `preview_url` still populated?** If it is, 30-second clips are plain MP3s with no DRM, and would allow real analysis of Spotify content — worth knowing, though 30 seconds is not a playlist.

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://api.spotify.com/v1/tracks/11dFghVXANMlKmJXsNCbNl' | grep -o '"preview_url":[^,]*'
```
