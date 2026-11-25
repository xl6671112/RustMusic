# JIZURA Web Lyrics

This integration vendors the complete JIZURA browser engine and all expression
packs. Its settings are native player controls, independent of the Folia and
HTML lyric renderers.

Upstream: https://github.com/852wa/JIZURA

Pinned commit: `4c8278cef161b38b132055e7b5efa112a5d41790` (v0.13.0).

Copyright (c) 2026 hakoniwa. The original MIT license and dependency notices are
preserved in `upstream/LICENSE` and `upstream/THIRD_PARTY_NOTICES.md`.

Run `node scripts/build-jizura.mjs` from the player root. This assembles every
upstream engine source in the original order. Checked integration hooks
accept literal API lyric lines and exact native timing, and prevent typesetting
from advancing the native clock. Cut combinations stay inside their native line
even for rapid lyrics, and saved manual cut times cannot override the API.
The build fails if a hook no longer matches.
The localized upstream registries provide `catalog.json` for native controls.

The build manifest lists every original engine file and its SHA-256 digest.
The manifest also lists the integration hooks. `upstream/build.py`,
`upstream/app`, `upstream/vendor`, and `upstream/editor.zh-Hans.html` retain
the original generation sources and provenance.

The native server serves the render document at `/jizura` and its assets at
`/jizura-assets/`. It selects the render
document at `/lyrics` when the `jizura` preset is active.

Settings live exclusively in `settings.jizura`. The `project` value preserves
the complete original project, including individual cut overrides, expression
selections, fonts, palette, locks, seed and transitions. `transparent` switches
the original renderer's alpha mode; it does not remove backgrounds using a
color key. Native playback owns the lyric clock, and the full song is planned
once per lyric or project change. Native API lyrics and their timestamps always
replace any lyrics and manually edited timing in saved projects. Untimed API
lyrics use the player's whole-song equal split. With no API lyrics the canvas
is cleared. `lineEffectsTrackKey` binds individual line overrides to the current
track; global effect combinations remain available across songs.
