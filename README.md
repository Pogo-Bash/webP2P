# WebP2P

**Peer-to-peer encrypted file sharing that leaves no trace.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)
![No Tracking](https://img.shields.io/badge/tracking-none-success.svg)
![Ephemeral](https://img.shields.io/badge/storage-ephemeral-purple.svg)

<p align="center">
  <img src="https://media.giphy.com/media/3o7btPCcdNniyf0ArS/giphy.gif" width="200" alt="secure transfer">
</p>

## What is this?

Drop a file. Get some links. Send each link to a different person. They help share it. Everyone closes their tabs? The file is gone forever. No server ever had it.

**That's it.** No accounts. No cloud. No "we respect your privacy" nonsense — there's simply nothing to store.

## How it works

```
You                     Your friends                  Someone downloading
 │                           │                              │
 ├── Drop file               │                              │
 ├── Get 3 links ────────────┼──► Each person opens a link  │
 │                           ├──► They cache their part     │
 │                           │                              │
 │                           │    ◄────────────────────────┼── Connects to everyone
 │                           │    ────► Sends chunks ──────┼──► Assembles file
 │                           │                              │
 └── Close tab               └──► Close tabs                │
                                                            │
                         ✨ File no longer exists anywhere ✨
```

- Files are split into chunks and encrypted in your browser
- Chunks transfer directly between browsers (WebRTC)
- The server only helps browsers find each other — it never sees your files
- When everyone leaves, the file is unrecoverable

## Features

- 🔒 **End-to-end encrypted** — AES-256-GCM, keys never touch a server
- 🌐 **True P2P** — Direct browser-to-browser transfers
- 📦 **No file size limits** — Limited only by browser memory
- 🧩 **Split across peers** — No single person has the full file
- 🕳️ **Ephemeral** — Close the tabs, file is gone
- 🚫 **No accounts** — No signup, no tracking, no cookies

<p align="center">
  <img src="https://media.giphy.com/media/l0HlNQ03J5JxX6lva/giphy.gif" width="200" alt="privacy">
</p>

## Quick start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Run production server
npm start
```

Development runs the Vue frontend on Vite's dev server and the signaling server on port 3001.

## Usage

### Sharing a file

1. Drop a file on the homepage
2. Choose how many parts to split it into (2-5)
3. Click "Generate Share Links"
4. Send each link to a different person
5. Keep your tab open until others have cached their parts

### Helping share (seeding)

1. Open the link someone sent you
2. Keep the tab open
3. That's it — you're helping share the file

### Downloading

1. Paste any of the share links on the homepage
2. Wait for chunks to download from available seeders
3. Save the file when complete

## Self-hosting

The only server component is the signaling server — it just helps browsers find each other. You can run your own:

```bash
npm run build
npm start
```

Set `PORT` environment variable if needed (default: 3001).

## FAQ

**Q: What does the server see?**

Room IDs (random strings) and which peers connected. No file names, no file contents, no encryption keys.

**Q: Can someone with 2 out of 3 links recover the file?**

They'd have the encryption key (it's in every link) but only ~66% of the chunks. The file would be incomplete/corrupted.

**Q: What if all seeders leave?**

The file is gone. This is intentional.

**Q: Is this like torrents?**

Similar concept, but everything happens in the browser and nothing persists. No trackers, no DHT, no permanent swarm.

**Q: Should I use this for important backups?**

Absolutely not. This is for transfers, not storage. Once everyone leaves, the file is unrecoverable.

<p align="center">
  <img src="https://media.giphy.com/media/3o7TKtnuHOHHUjR38Y/giphy.gif" width="200" alt="disappear">
</p>

## Tech stack

- **Frontend:** Vue 3, TypeScript, Tailwind CSS, DaisyUI
- **Signaling:** Node.js, WebSocket
- **P2P:** WebRTC DataChannels
- **Crypto:** Web Crypto API (AES-256-GCM)
- **Caching:** Origin Private File System (OPFS)

## Limitations

- Requires at least one seeder to be online for downloads
- WebRTC may struggle with strict corporate firewalls
- Large files need sufficient browser memory
- No persistence — by design

## Contributing

PRs welcome! Please keep the "no server storage" principle intact.

## License

MIT — do whatever you want.

---

<p align="center">
  <i>Built for sharing things that shouldn't stick around.</i>
</p>

<p align="center">
  <img src="https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif" width="150" alt="bye">
</p>
