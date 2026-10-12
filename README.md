# The Diary — riddle for the Supernote

A Supernote plugin port of [riddle](https://github.com/MaximeRivest/riddle) by
Maxime Rivest: the diary of Tom Riddle. Write on the page and rest your pen.
The diary drinks your ink: it fades into the paper. Then an answer writes
itself back, letter by letter, in a flowing hand, lingers, and fades away.

Built for the **Manta (A5X2)** with `sn-plugin-lib` 0.2.3, on firmware
`Chauvet.E103.2610…`. The layout scales to the page, so other models may work
too.

```
 your pen ─► note app ─► The Diary plugin (on the tablet)
                          │ reads your strokes (on-device handwriting recognition)
                          │ shows the page on its own layer, deletes the real strokes
                          │ fades your ink while the spirit composes
                          ▼
            http://<mac-or-pi>:8787/v1 ── diary bridge ──┬─► claude -p (your Claude plan)
            (or https://api.openai.com/v1 with a key)     └─► Ollama (gemma4:e4b / e2b)
                          │
                          ▼
            Tom's reply, written stroke by stroke in Dancing Script, then gone
```

## Use it

| Do this | And |
|---|---|
| Write in a note whose name contains **diary**, then **hold the pen still on your last stroke** (~1.2 s) | Your ink fades away and Tom replies, letter by letter |
| …or tap **The Diary** in the sidebar | Same thing, no pen rest needed |
| Tap the page while Tom's reply is showing | The page returns. Otherwise the reply fades on its own after 8–40 s |
| Write *"show me the page about…"* | The remembered page comes back faded: its date, your own handwriting rewriting itself, Tom's old reply. Tap to return |
| Write *"what do you remember?"* | Tom answers with remembered moments and their dates |
| Tap **The Diary** on an empty diary page | Opens the settings |
| Tap **The Diary** in any other note | Offers to create and open `Note/Diary.note` |

The diary only acts in notes whose file name contains the word set under
"Diary notes" (default `diary`). Drinking the ink deletes strokes, so other
notes are never touched.

Like riddle, Tom's replies are not kept on the page. They are kept in the
diary's memory, so he follows the conversation and "show me…" works. If you'd
rather keep his replies as ink in the note, set "Tom's reply appears" to
*Line by line* or *All at once*. That's slower: every pen line added to a
note costs 60–85 ms on a Manta.

## How it works on the tablet

These are the constraints we hit on a real Manta, and how the plugin works
around them:

- **No idle timer.** Riddle commits the page after 2.8 s without the pen. A
  plugin's JS timers stall while its view is closed, so instead you rest the
  pen on the page. That rest is measured from pen motion timestamps
  (`src/hold.ts`).
- **Editing a note is slow.** Each element inserted, recolored or changed
  costs 60–85 ms and blocks the plugin: a 375-line reply took 32 s. So the
  scene plays on the plugin's own full-screen view (`src/stage.ts`). Your
  strokes are redrawn there exactly in place, the real ones are deleted in a
  single call underneath, and the fade and the quill are animated on the view.
- **No plain HTTP.** The plugin host targets Android 15 with no cleartext
  exception, so `fetch("http://…")` is refused before it leaves the tablet.
  Requests to an `http://` bridge go through a small raw-socket HTTP client in
  the native module (`DiaryFilesModule.kt`). `https://` uses fetch.
- **No file writes in the SDK.** The native module also handles settings,
  memories and the log.

## 1. Run the bridge (Mac or Pi)

The tablet can't use your Claude login by itself, and Gemma can't run on the
Manta. The bridge runs on a computer on the same Wi-Fi:

```sh
DIARY_TOKEN=$(cat bridge/.diary-token) node bridge/diary-bridge.mjs
# diary bridge listening on 0.0.0.0:8787
#   tablet Server setting: http://192.168.1.20:8787/v1
```

It needs Node 18+ and nothing else. The **model name** set on the tablet
picks the backend:

| Model on the tablet | Backend | Measured |
|---|---|---|
| `claude` | `claude -p --model haiku` via your Claude Code login (Pro/Max) → **Claude Haiku 5.5** | 2.5–4.5 s per reply |
| `claude-sonnet`, `claude-opus` | same, bigger model | slower, richer |
| `gemma4:e4b` | Ollama on the bridge machine | 3–4.5 s warm (11 s first call) |
| `gemma4:e2b` | Ollama | 1.5–2.5 s warm; weaker: misread an Italian question |

- **Claude:** run `claude` once on that machine and log in. The bridge runs
  `claude -p` with no tools, no MCP servers, no settings and no saved session,
  in an empty temp folder. Replies count toward your plan's usage limits.
- **Ollama:** `ollama pull gemma4:e4b`. The bridge talks to `127.0.0.1:11434`
  (set `OLLAMA_URL` to change it) and turns Gemma's thinking off.
- **Always set `DIARY_TOKEN`.** Without it, anyone on your Wi-Fi can use your
  Claude plan through the bridge. Other variables: `PORT` (8787),
  `CLAUDE_MODEL` (haiku), `CLAUDE_BIN`, and `DIARY_LOG_TEXT=1` to log page text
  and replies.

On a Raspberry Pi, keep it running with systemd
(`/etc/systemd/system/diary-bridge.service`):

```ini
[Unit]
Description=Diary bridge
After=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/the_diary/bridge
Environment=DIARY_TOKEN=pick-a-secret
ExecStart=/usr/bin/node diary-bridge.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Or: no computer, with an OpenAI key

The tablet can also talk to OpenAI directly over HTTPS, like riddle's default
mode:

```sh
cd plugin && ./scripts/build-openai.sh ~/path/to/key.txt
# tries gpt-5-mini, gpt-4.1-mini, gpt-4o-mini with one tiny request each
# → ../dist/TheDiary-openai.snplg
```

That uses pay-per-use API billing, separate from any ChatGPT or Claude
subscription.

## 2. Build the plugin with your settings baked in

So you don't have to type a URL and token on the e-ink keyboard:

```sh
cd plugin
npm install
./scripts/build-bridge.sh http://<bridge-ip>:8787/v1          # model "claude"
./scripts/build-bridge.sh http://<bridge-ip>:8787/v1 gemma4:e4b
# → ../dist/TheDiary-bridge.snplg
```

Baked settings live in the git-ignored `src/baked.ts`. Both scripts restore
the empty version afterwards, but **the `.snplg` they produce contains your
token or key**, so don't share it.

To build without anything baked in (settings typed on the tablet):
`JAVA_HOME=$(/usr/libexec/java_home -v 21) ANDROID_HOME=~/Library/Android/sdk ./buildPlugin.sh`.
This needs JDK 19+ (OpenJDK 21 used here), Android SDK 35 and Node 18+. Bump
`versionCode` in `PluginConfig.json` for each release: the tablet only
upgrades when it increases.

## 3. Install on the tablet

1. Copy the `.snplg` into the tablet's **MyStyle** folder (USB, the Partner
   app, or `adb push … /sdcard/MyStyle/` when sideloading is on).
2. **Settings → Apps → Plugins → Select Plugin Package**, pick the file, tap
   **Install**. (Go to InkHub is the online store, not this.)
3. Grant **Permissions** for files and network on the plugin's page, or allow
   them when the first page asks.
4. Make a note with "diary" in its name, write, and rest your pen.

If something misbehaves, the log is `Document/TheDiary/diary.log` (or in the
plugin's private folder until file permission is granted). With ADB:
`adb logcat | grep '\[Diary\]'`.

## Status

On a Manta: page reading and handwriting recognition, deleting your
strokes, the bridge over the native HTTP client, and Claude's replies all
work. The in-note ink modes (Line by line / All at once) work but are slow
for long replies. The stage animation (fade + letter-by-letter quill,
`v0.1.5`) is built and unit-tested but **not yet seen on the device**. A long
reply is ~2,000 native views, and whether e-ink keeps up smoothly is the open
question.

## Tests

```sh
cd plugin
npx jest                     # layout, prompts, parsing, pen rest, stage maths
LIVE=1 TOKEN=… MODELS=claude,gemma4:e4b npx jest live   # against a running bridge
cd ../tools/atlas && cargo run --release -- ../../plugin/src/hand/atlas.json   # rebake Tom's hand
```

## Layout

```
bridge/diary-bridge.mjs       OpenAI-compatible endpoint → claude -p / Ollama
plugin/index.js               buttons and pen listeners (module scope: they work with the view closed)
plugin/App.tsx                the plugin view: the stage, or the settings screen
plugin/src/diary.ts           one turn: read → drink → ask → write → linger; conjuring
plugin/src/stage.ts           the scene over the page: show / fade / write layers
plugin/src/StageView.tsx      draws the stage (each segment a thin rotated View)
plugin/src/sdk.ts             every note-app call (read, delete, insert, repaint, recognise)
plugin/src/hand/              Tom's hand: baked glyph atlas + layout
plugin/src/prompt.ts          riddle's persona, memory catalog, ⟦show:N⟧ / ⁂ parsing
plugin/src/oracle.ts          chat-completions client (native socket for http://)
plugin/src/memory.ts          pages remembered on the tablet (max 200)
plugin/src/hold.ts            pen-rest detection
plugin/android/…/DiaryFiles*.kt   file I/O + plain-HTTP client
plugin/scripts/               build-bridge.sh, build-openai.sh, bake-key.mjs
tools/atlas/                  Rust: Dancing Script → thinned, traced pen paths
```

## What leaves the tablet

The recognised text of the page goes to the server you configured, plus
recent pages if memory is on. A PNG of the page goes too when no words were
recognised (or always, if you choose that). Memories (your strokes, the
transcript and Tom's reply) stay in the plugin's folder on the tablet.

## Credits

- [riddle](https://github.com/MaximeRivest/riddle) by Maxime Rivest (MIT). This
  port reuses its persona and memory prompts, its memory design, and its
  rasterize → Zhang-Suen thinning → stroke tracing pipeline.
- [Dancing Script](https://github.com/googlefonts/DancingScript) (SIL OFL 1.1,
  `tools/atlas/fonts/OFL.txt`). The plugin ships pen paths derived from it.
- Supernote plugin behaviour notes from the community: SuperDashboard's
  FINDINGS, and the Patterns and Snap plugins' documentation.

Not affiliated with Ratta/Supernote or with the riddle project.
