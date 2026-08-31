# X/Twitter Downloader (xdl)

Paste any `x.com` / `twitter.com` tweet link → preview → download. A small, self-hosted web app for saving videos (and GIFs/photos) from X. Mobile-first, works great on phones.

**You host it yourself** — there's no hosted instance. It runs on your own server (or just your laptop), so it's free, private, and no third-party download site is involved.

## Features

- 📱 Mobile-first UI (dark theme, add-to-home-screen friendly)
- 🎬 Quality picker with file sizes (270p → 720p+); picks the best available
- 🎞️ Handles **videos**, **GIFs**, **photo-only tweets**, and **mixed video+photo** tweets
- 🔗 1080p HLS-only tweets are merged server-side via ffmpeg automatically
- ⚡ Direct CDN streaming for downloads (no big server-side buffering), inline preview plays straight from X's CDN
- 🛡️ Per-IP rate limits, concurrency caps, CDN host allowlist (no SSRF)
- 🔌 Zero npm dependencies — only `node`, `ffmpeg`, `yt-dlp`

## How it works

- **Extraction:** [yt-dlp](https://github.com/yt-dlp/yt-dlp) is primary (guest-token based, keeps up with X API changes). If it fails or hits rate limits, it falls back to the [FxTwitter API](https://github.com/FxEmbed/FxEmbed#api) — no auth, instant, and covers photos/GIFs.
- **Download:** the server streams the file through with a proper filename (`Content-Disposition: attachment`) so saving on iOS/Android "Files" works out of the box.
- **Preview:** served straight from X's CDN (`video.twimg.com`, CORS `*`) — zero bandwidth on your server while watching.

## Requirements

- Node.js ≥ 18
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) on PATH (or set `YTDLP` env)
- `ffmpeg` on PATH (only needed for HLS/1080p merges)

## Quick start (local)

```bash
pip install yt-dlp        # or pipx / brew / binary from github
ffmpeg -version           # ensure ffmpeg is installed too

node server.js            # listens on http://127.0.0.1:18820
# open http://127.0.0.1:18820
```

Environment overrides:

| Env | Default | What |
|-----|---------|------|
| `PORT` | `18820` | listen port (binds to 127.0.0.1) |
| `YTDLP` | `yt-dlp` | path to yt-dlp binary |
| `TMP_DIR` | `/tmp/xdl` | temp dir for HLS merges |

## Deploy to a server

```bash
VPS_HOST=user@your.server ./deploy.sh
# or: echo 'VPS_HOST=user@your.server' > .deploy.local   (gitignored)
```

The script copies the app to `/opt/xdl`, creates a venv with yt-dlp, installs a `xdl.service` systemd unit bound to `127.0.0.1:18820`, and starts it.

Then put a reverse proxy in front. Example with Caddy:

```caddyfile
dl.example.com {
    reverse_proxy 127.0.0.1:18820
}
```

Or keep it private with Tailscale/ZeroTier/nginx — your call; the rate limits work for any audience, but it's built for personal use.

## API

| Route | Purpose |
|-------|---------|
| `POST /api/extract` `{url}` | metadata + `videos[]` (quality, size, CDN url) + `photos[]` |
| `GET /media?url=<cdn>` | 302 → CDN (inline preview; only `video.twimg.com`/`pbs.twimg.com` allowed) |
| `GET /dl?url=<cdn>&name=<file>` | streamed download (attachment header) |
| `GET /dl?v=<id>&fid=<hls>&name=<file>` | HLS → ffmpeg merge → download |
| `GET /api/status` | health check |
| `GET /` | the web UI |

## Notes

- Built and tested for **personal use** — respect content rights, don't mass-download.
- Not affiliated with X Corp. The 𝕏 mark in the UI is just a nod.
- Thanks to [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [FxEmbed/FxTwitter API](https://github.com/FxEmbed/FxEmbed) for making this possible.

## License

MIT — see [LICENSE](LICENSE).