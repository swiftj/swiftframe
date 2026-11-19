# SwiftFrame

Control a Samsung Frame TV from Apple Home and from Claude, over your local network.

One repository, three packages that share the same TV code:

| Package | What it is |
| --- | --- |
| [`swiftframe-core`](packages/core) | TypeScript library: power, remote keys, apps, volume, Art Mode and artwork management |
| [`homebridge-swiftframe`](packages/homebridge) | Homebridge plugin that puts the TV in Apple Home |
| [`swiftframe-mcp`](packages/mcp) | MCP server that lets Claude (or any MCP client) control the TV and manage its artwork |

> **Status: 0.1, not yet run against a real TV.** Everything is tested against a mock TV that speaks the same
> protocol as a 2022 Frame (art API 4.3.4.0). The protocol behaviour comes from two established open-source
> projects (see [Credits](#credits)), but expect rough edges on real hardware. Please open an issue with the
> debug log when something does not match.

## What you get

**In Apple Home (plugin)**

- A TV tile with remote control, volume and mute
- Art Mode switch, kept in sync when someone uses the physical remote
- Art brightness as a dimmable light, so scenes and automations can dim the art
- Optional Next Artwork button and Slideshow switch
- Inputs for Art Mode, a specific artwork, an app, or a remote-key sequence
- Self-healing connections: dead sockets are detected and reconnected with backoff

**In Claude (MCP server)**

- Status, power, Art Mode, remote keys, apps, volume
- List, preview, show, upload, favourite and delete artwork
- Art brightness and colour tone, slideshow, mattes

## Requirements

- A Samsung Frame TV from 2018 or later that uses token pairing. Built for the 2022 LS03B; Art Mode on 2022+
  models needs firmware 1622 or newer.
- Node.js 22.12+, 24 or 26
- For the plugin: Homebridge 1.8+ (2.x recommended)
- The TV on a fixed IP address (reserve one on your router)

## Homebridge plugin

### Install

Until the plugin is published to npm, build a tarball and install that:

```sh
git clone https://github.com/swiftj/swiftframe.git
cd swiftframe
npm install
npm run pack        # writes homebridge-swiftframe-0.1.0.tgz and swiftframe-mcp-0.1.0.tgz
```

Copy `homebridge-swiftframe-0.1.0.tgz` to the Homebridge machine and install it where your other plugins live.
On a standard Linux install that is:

```sh
sudo npm install --prefix /var/lib/homebridge ./homebridge-swiftframe-0.1.0.tgz
```

Then restart Homebridge. The tarball is self-contained; it does not need `swiftframe-core` installed separately.

### Configure

Use the plugin's settings screen in the Homebridge UI, or add this to `config.json`:

```json
{
  "platform": "SwiftFrame",
  "tvs": [
    {
      "name": "Frame",
      "ip": "192.168.1.50",
      "mac": "AA:BB:CC:DD:EE:FF",
      "tileMode": "art",
      "nextArtworkSwitch": true,
      "inputs": [
        { "name": "Art Mode", "type": "artmode" },
        { "name": "HDMI", "type": "key", "value": "KEY_HDMI" }
      ]
    }
  ]
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `ip` | required | The TV's address |
| `mac` | discovered | Needed to wake the TV when it is fully off |
| `tileMode` | `art` | `art`: tile off = Art Mode, on = TV. `power`: tile off = screen off, on = wake |
| `artModeSwitch` | `true` | Separate Art Mode switch |
| `brightnessLight` | `true` | Art brightness as a dimmable light |
| `nextArtworkSwitch` | `false` | Momentary button that shows the next artwork |
| `nextArtworkCollection` | `favorites` | `favorites`, `photos` or `all`; also used by the slideshow |
| `slideshowSwitch` | `false` | Switch that turns the slideshow on and off |
| `slideshowMinutes` | `30` | Slideshow interval. The TV only accepts certain values |
| `pollInterval` | `15` | Seconds between state checks |
| `inputs` | none | `artmode`, `artwork` (content id), `app` (Tizen app id) or `key` (comma-separated keys) |

### Add to Home

1. Turn the TV on and restart Homebridge.
2. Accept the **Homebridge** prompt on the TV with your remote. This happens once.
3. In the Home app choose **Add Accessory > More options**, pick the TV and enter your Homebridge PIN. The TV is
   published as its own accessory (Home requires that for TVs), so it does not appear under the bridge.

### Running alongside homebridge-samsung-tizen

Both plugins can be installed at once, but point only one of them at a given TV. Remove the TV from the other
plugin and from Home first, or you will have two tiles for the same set.

## MCP server

The server runs on a computer on the same network as the TV and talks to Claude over stdio.

Build it as above, then register it. For Claude Code:

```sh
claude mcp add swiftframe --env SWIFTFRAME_HOST=192.168.1.50 -- node /path/to/swiftframe/packages/mcp/dist/index.js
```

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "swiftframe": {
      "command": "node",
      "args": ["/path/to/swiftframe/packages/mcp/dist/index.js"],
      "env": {
        "SWIFTFRAME_HOST": "192.168.1.50",
        "SWIFTFRAME_UPLOAD_DIRS": "/Users/you/Pictures/Frame"
      }
    }
  }
}
```

| Variable | Meaning |
| --- | --- |
| `SWIFTFRAME_HOST` | The TV's IP address (required) |
| `SWIFTFRAME_MAC` | MAC address, to wake a fully-off TV |
| `SWIFTFRAME_UPLOAD_DIRS` | Folders uploads may come from, separated by `:` (`;` on Windows). Unset means any folder |
| `SWIFTFRAME_TOKEN_FILE` | Where to keep the pairing token. Default `~/.swiftframe/<host>.token` |
| `SWIFTFRAME_CLIENT_NAME` | Name on the TV's pairing prompt. Default `Claude` |
| `SWIFTFRAME_DEBUG` | Set to `1` for protocol logging on stderr |

The first command that needs pairing makes the TV show an Allow prompt for **Claude**. The plugin and the MCP
server pair separately, so expect one prompt for each.

Tools: `frame_status`, `frame_pair`, `frame_power`, `frame_art_mode`, `frame_send_keys`, `frame_launch_app`,
`frame_volume`, `frame_list_art`, `frame_current_art`, `frame_show_art`, `frame_upload_art`, `frame_delete_art`,
`frame_favorite_art`, `frame_art_thumbnail`, `frame_art_settings`, `frame_slideshow`, `frame_list_mattes`,
`frame_set_matte`.

## Using the core library

```ts
import { FileTokenStore, FrameTV } from 'swiftframe-core';

const tv = new FrameTV({ host: '192.168.1.50', tokenStore: new FileTokenStore('./tv.token') });

await tv.pair();                       // accept the prompt on the TV the first time
await tv.setArtMode(true);
const id = await tv.art.upload(await readFile('autumn.jpg'));
if (id) await tv.art.select(id);

tv.on('state', (state) => console.log(state.status)); // on | art | standby | off
await tv.start();                      // begin tracking state
```

## Known limits

- **No SmartThings yet.** Switching to a specific HDMI input, picture modes and a guaranteed full power-off need
  Samsung's cloud API. Locally, `KEY_HDMI` cycles inputs.
- **Full power-off is best effort on a Frame.** A short power press only toggles Art Mode, so the code sends a long
  press. Some newer firmware ignores that over the network; the command then reports that the TV did not turn off.
- **The art service can go quiet.** 2022 Frames sometimes stop answering art requests after watching TV. The client
  detects this, reconnects, and pauses art requests briefly instead of hanging.
- **Volume is the TV's own speakers.** A soundbar may not follow.

## Security notes

- The TV uses a self-signed certificate, so the encrypted connection to it cannot be verified. Use this only on a
  network you trust.
- The pairing token lets anything on your network control the TV. It is stored in a file only your user can read.
- The MCP server only reads files that are real JPEG or PNG images, and only from `SWIFTFRAME_UPLOAD_DIRS` when set.

## Development

```sh
npm install
npm run check      # type-check, tests, build
npm test           # tests only
```

Tests run against [`packages/core/test/mock-tv.ts`](packages/core/test/mock-tv.ts), a small server that imitates
the TV's HTTP, WebSocket, file-transfer and volume interfaces.

## Credits

Samsung does not document these interfaces. This project's understanding of them comes from reading:

- [homebridge-samsung-tizen](https://github.com/tavicu/homebridge-samsung-tizen) by Octavian Ruda (MIT)
- [samsung-tv-ws-api](https://github.com/NickWaterton/samsung-tv-ws-api) by Nick Waterton and contributors (LGPL-3.0)

No code from either project is included; the implementation here is original.

Not affiliated with or endorsed by Samsung. "The Frame" and "SmartThings" are trademarks of Samsung.

## License

MIT
