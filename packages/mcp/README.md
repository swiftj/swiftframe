# swiftframe-mcp

An MCP server that lets Claude, or any MCP client, control a Samsung Frame TV on your network and manage its artwork.

Ask for things like "put the TV in Art Mode", "upload the photos in my Frame folder and show the first one", or
"dim the art to 3 and rotate my favourites every hour".

> **Early release.** Tested against a simulated 2022 Frame, with limited time on real hardware so far.
> Please [report problems](https://github.com/swiftj/swiftframe/issues).

## Requirements

- A Samsung Frame TV from 2018 or later. Art Mode on 2022 and newer models needs TV firmware 1622 or newer.
- Node.js 22.12+, 24 or 26 on a computer on the same network as the TV
- The TV's IP address (reserve a fixed one on your router)

## Set up

**Claude Code**

```sh
claude mcp add swiftframe --env SWIFTFRAME_HOST=192.168.1.50 -- npx -y swiftframe-mcp
```

**Claude Desktop**: add to `claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "swiftframe": {
      "command": "npx",
      "args": ["-y", "swiftframe-mcp"],
      "env": {
        "SWIFTFRAME_HOST": "192.168.1.50",
        "SWIFTFRAME_UPLOAD_DIRS": "/Users/you/Pictures/Frame"
      }
    }
  }
}
```

The first command that needs it makes the TV show an Allow prompt for **Claude**. Accept it with the remote once.

## Options

| Variable | Meaning |
| --- | --- |
| `SWIFTFRAME_HOST` | The TV's IP address (required) |
| `SWIFTFRAME_MAC` | MAC address, to wake a fully-off TV |
| `SWIFTFRAME_UPLOAD_DIRS` | Folders uploads may come from, separated by `:` (`;` on Windows). Unset means any folder |
| `SWIFTFRAME_TOKEN_FILE` | Where to keep the pairing token. Default `~/.swiftframe/<host>.token` |
| `SWIFTFRAME_CLIENT_NAME` | Name on the TV's pairing prompt. Default `Claude` |
| `SWIFTFRAME_DEBUG` | Set to `1` for protocol logging on stderr |

## Tools

| Tool | What it does |
| --- | --- |
| `frame_status` | On, art, standby or off, plus model and firmware |
| `frame_pair` | Pair with the TV |
| `frame_power` | Turn the TV on or fully off |
| `frame_art_mode` | Switch Art Mode on or off |
| `frame_send_keys` | Press remote keys |
| `frame_launch_app` | Open an app by Tizen app id |
| `frame_volume` | Read or change volume and mute |
| `frame_list_art`, `frame_current_art` | See what artwork is on the TV and which is selected |
| `frame_art_thumbnail` | Preview an artwork |
| `frame_show_art` | Display an artwork |
| `frame_upload_art` | Upload a JPEG or PNG and optionally display it |
| `frame_favorite_art`, `frame_delete_art` | Favourite or delete artwork |
| `frame_art_settings` | Read or change art brightness and colour tone |
| `frame_slideshow` | Read or set automatic rotation |
| `frame_list_mattes`, `frame_set_matte` | List mattes and change an artwork's matte |

## Safety

- Uploads are limited to real JPEG or PNG files up to 25 MB, and to `SWIFTFRAME_UPLOAD_DIRS` when you set it.
- `frame_delete_art` permanently removes images from the TV.
- The pairing token lets anything on your network control the TV. It is saved in a file only your user can read.
- The TV uses a self-signed certificate, so the connection to it cannot be verified. Use it on a network you trust.

Part of [SwiftFrame](https://github.com/swiftj/swiftframe), which also includes a Homebridge plugin built on the same
code. Not affiliated with or endorsed by Samsung. MIT licence.
