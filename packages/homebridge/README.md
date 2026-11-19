# SwiftFrame for Homebridge

Put a Samsung Frame TV in Apple Home, with real Art Mode control.

- TV tile with remote control, volume and mute
- Art Mode switch that stays in sync with the physical remote
- Art brightness as a dimmable light, so scenes and automations can dim the art
- Optional Next Artwork button and Slideshow switch
- Inputs for Art Mode, a specific artwork, an app, or a remote-key sequence
- Connections that detect a dead socket and reconnect on their own

> **Early release.** Tested against a simulated 2022 Frame, with limited time on real hardware so far. If something
> misbehaves, please [open an issue](https://github.com/swiftj/swiftframe/issues) with the Homebridge debug log.

## Requirements

- A Samsung Frame TV from 2018 or later. Art Mode on 2022 and newer models needs TV firmware 1622 or newer.
- Homebridge 1.8 or newer (2.x recommended) on Node.js 22.12+, 24 or 26
- A fixed IP address for the TV (reserve one on your router)

## Install

In the Homebridge UI open **Plugins**, search for **SwiftFrame**, and choose **Install**.

Or from a terminal:

```sh
hb-service add homebridge-swiftframe
```

## Set up

1. Open the plugin's **Settings**, add a TV, and enter its name and IP address. Save and restart Homebridge.
2. With the TV on, accept the **Homebridge** prompt on its screen using the remote. This happens once.
3. In the Home app choose **Add Accessory > More options**, pick the TV and enter your Homebridge PIN. Home requires
   TVs to be added as their own accessory, so it will not appear under the bridge automatically.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Name | required | How the TV appears in Home |
| IP address | required | The TV's address |
| MAC address | discovered | Needed to wake the TV when it is fully off |
| TV tile power button | Off = Art Mode | Or choose Off = screen off, On = wake |
| Art Mode switch | on | Separate switch for Art Mode |
| Art brightness light | on | Art brightness as a dimmable light |
| Next Artwork button | off | Momentary button that shows the next artwork |
| Collection | Favorites | Used by Next Artwork and Slideshow: Favorites, My Photos or Everything |
| Slideshow switch | off | Turns the TV's slideshow on and off |
| Slideshow interval | 30 min | The TV only accepts certain values |
| Inputs | none | Art Mode, a specific artwork, an app id, or remote keys such as `KEY_HDMI` |

The same options in `config.json`:

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

## Good to know

- **Coming from homebridge-samsung-tizen?** Point only one plugin at a given TV. Remove the TV from the other plugin
  and from Home first, or you will have two tiles for the same set.
- **Full power-off is best effort on a Frame.** A short power press only toggles Art Mode, so the plugin sends a long
  press, which some newer firmware ignores over the network. The default tile mode avoids this by using Art Mode as "off".
- **No SmartThings yet**, so there is no direct switch to a specific HDMI input. `KEY_HDMI` cycles through inputs.
- **Pairing token.** After you accept the prompt, a token is saved in your Homebridge storage folder under
  `swiftframe/`. If the TV ever rejects it, remove "Homebridge" from the TV's Device Connection Manager and restart.
- The TV uses a self-signed certificate, so the connection to it cannot be verified. Use it on a network you trust.

## Also in this project

[SwiftFrame](https://github.com/swiftj/swiftframe) includes an MCP server, `swiftframe-mcp`, that lets Claude and
other AI assistants control the TV and upload artwork, built on the same code as this plugin.

Not affiliated with or endorsed by Samsung. MIT licence.
