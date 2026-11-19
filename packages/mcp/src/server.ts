import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ArtCategory, detectImageType, errorMessage, type FrameTV } from 'swiftframe-core';
import { z } from 'zod';

export interface ServerOptions {
  /** If set, uploads may only come from inside these directories. */
  uploadDirs?: string[];
  /** Largest image the server will read, in bytes. */
  maxUploadBytes?: number;
}

/** Replaced with the package version at build time; absent when running from source. */
declare const __SWIFTFRAME_VERSION__: string | undefined;
const VERSION = typeof __SWIFTFRAME_VERSION__ === 'string' ? __SWIFTFRAME_VERSION__ : '0.0.0-dev';

const COLLECTIONS = {
  photos: ArtCategory.MY_PHOTOS,
  favorites: ArtCategory.FAVORITES,
  store: ArtCategory.ART_STORE,
} as const;

const collection = z
  .enum(['photos', 'favorites', 'store', 'all'])
  .describe('photos = images the owner uploaded, favorites = pieces marked as favourite, store = Art Store pieces, all = everything');

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** Build the MCP server for one TV. Separate from the transport so it can be tested in-process. */
export function createServer(tv: FrameTV, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'swiftframe', version: VERSION });
  const maxUploadBytes = options.maxUploadBytes ?? 25 * 1024 * 1024;

  /** Turn any failure into a readable tool error instead of a protocol error. */
  const run = async (action: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await action();
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
    }
  };

  /** Art and remote commands need pairing; the first one makes the TV show its Allow prompt. */
  const paired = async (): Promise<void> => {
    if (!tv.isPaired) {
      await tv.pair();
    }
  };

  const art = async () => {
    await tv.requireFrame();
    await paired();
    return tv.art;
  };

  server.registerTool(
    'frame_status',
    {
      title: 'TV status',
      description:
        'Report whether the TV is on (showing TV), art (showing Art Mode), standby (screen off) or off (unreachable), plus model and firmware. Call this first when unsure what the TV is doing.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const state = await tv.refresh();
        const info = state.reachable ? await tv.getInfo() : undefined;

        return text({
          status: state.status,
          artMode: state.artMode,
          paired: tv.isPaired,
          model: info?.modelName,
          firmware: info?.firmware,
          isFrame: info?.frameSupport,
        });
      }),
  );

  server.registerTool(
    'frame_pair',
    {
      title: 'Pair with the TV',
      description:
        'Pair this server with the TV. The TV must be on; it shows an Allow/Deny prompt that someone must accept with the remote within about a minute. Only needed once.',
    },
    () =>
      run(async () => {
        await tv.pair();
        return text('Paired with the TV.');
      }),
  );

  server.registerTool(
    'frame_power',
    {
      title: 'Turn the TV on or off',
      description:
        'on = wake the TV and show regular TV (leaves Art Mode). off = turn the screen fully off. To show art instead of turning off, use frame_art_mode. Some Frame firmware ignores a network power-off and stays in Art Mode; the tool reports that if it happens.',
      inputSchema: { power: z.enum(['on', 'off']) },
    },
    ({ power }) =>
      run(async () => {
        await paired();
        await (power === 'on' ? tv.turnOn() : tv.turnOff());
        return text(`The TV is now ${tv.state.status}.`);
      }),
  );

  server.registerTool(
    'frame_art_mode',
    {
      title: 'Switch Art Mode',
      description: 'Turn Art Mode on (display artwork) or off (return to regular TV). Wakes the TV first if its screen is off.',
      inputSchema: { on: z.boolean() },
    },
    ({ on }) =>
      run(async () => {
        await paired();
        await tv.setArtMode(on);
        return text(`Art Mode is ${on ? 'on' : 'off'}.`);
      }),
  );

  server.registerTool(
    'frame_send_keys',
    {
      title: 'Press remote keys',
      description:
        'Press one or more remote-control keys in order, e.g. ["KEY_HOME"], ["KEY_VOLUP","KEY_VOLUP"], ["KEY_HDMI"], ["KEY_MENU"]. Names are Samsung key codes; the KEY_ prefix is optional.',
      inputSchema: { keys: z.array(z.string().min(1)).min(1).max(20) },
    },
    ({ keys }) =>
      run(async () => {
        await paired();
        await tv.sendKeys(keys);
        return text(`Sent ${keys.length} key${keys.length === 1 ? '' : 's'}.`);
      }),
  );

  server.registerTool(
    'frame_launch_app',
    {
      title: 'Launch an app',
      description: 'Open an installed app by its numeric Tizen app id. The TV must be on.',
      inputSchema: { appId: z.string().min(1) },
    },
    ({ appId }) =>
      run(async () => {
        await paired();
        await tv.launchApp(appId);
        return text(`Asked the TV to open ${appId}.`);
      }),
  );

  server.registerTool(
    'frame_volume',
    {
      title: 'Read or change volume',
      description:
        'With no arguments, report the volume (0-100) and mute state. Pass level and/or mute to change them. Applies to the TV speakers; a soundbar may not follow.',
      inputSchema: { level: z.number().int().min(0).max(100).optional(), mute: z.boolean().optional() },
    },
    ({ level, mute }) =>
      run(async () => {
        if (level !== undefined) {
          await tv.volume.setVolume(level);
        }

        if (mute !== undefined) {
          await tv.volume.setMute(mute);
        }

        return text({ volume: await tv.volume.getVolume(), muted: await tv.volume.getMute() });
      }),
  );

  server.registerTool(
    'frame_list_art',
    {
      title: 'List artwork',
      description: 'List artwork stored on the TV with content ids, which the other art tools take. Defaults to uploaded photos.',
      inputSchema: { collection: collection.optional() },
      annotations: { readOnlyHint: true },
    },
    ({ collection: which }) =>
      run(async () => {
        const client = await art();
        const items = await client.list(which && which !== 'all' ? COLLECTIONS[which] : which === 'all' ? undefined : COLLECTIONS.photos);

        return text({
          count: items.length,
          artwork: items.map((item) => ({
            contentId: item.content_id,
            collection: item.category_id,
            matte: item.matte_id,
            width: item.width,
            height: item.height,
            date: item.image_date,
          })),
        });
      }),
  );

  server.registerTool(
    'frame_current_art',
    {
      title: 'Current artwork',
      description: 'Report which artwork is currently selected for Art Mode.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const client = await art();
        const current = await client.getCurrent();
        return text({ contentId: current.content_id, matte: current.matte_id, collection: current.category_id });
      }),
  );

  server.registerTool(
    'frame_show_art',
    {
      title: 'Show an artwork',
      description: 'Select an artwork by content id and display it, switching the TV into Art Mode if needed.',
      inputSchema: { contentId: z.string().min(1) },
    },
    ({ contentId }) =>
      run(async () => {
        const client = await art();

        if (tv.state.status !== 'art') {
          await tv.setArtMode(true);
        }

        await client.select(contentId, { show: true });
        return text(`Now showing ${contentId}.`);
      }),
  );

  server.registerTool(
    'frame_upload_art',
    {
      title: 'Upload an image',
      description:
        'Upload a JPEG or PNG from this computer to the TV and optionally display it. Give an absolute file path. For best results use a 3840x2160 (16:9) image. Returns the new content id.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to a .jpg or .png file on the computer running this server'),
        matte: z.string().optional().describe('Matte id such as "shadowbox_polar" or "none" (default). See frame_list_mattes.'),
        show: z.boolean().optional().describe('Display the image once uploaded (default true)'),
      },
    },
    ({ path, matte, show }) =>
      run(async () => {
        const image = await readImage(path, options.uploadDirs, maxUploadBytes);
        const client = await art();
        const contentId = await client.upload(image, { matte });

        if (!contentId) {
          return text('The image was sent but the TV did not confirm it in time. Check frame_list_art in a moment; it may still appear.');
        }

        if (show ?? true) {
          if (tv.state.status !== 'art') {
            await tv.setArtMode(true);
          }

          await client.select(contentId, { show: true });
        }

        return text({ contentId, shown: show ?? true });
      }),
  );

  server.registerTool(
    'frame_delete_art',
    {
      title: 'Delete uploaded artwork',
      description: 'Permanently delete uploaded images from the TV by content id. This cannot be undone. Art Store pieces cannot be deleted.',
      inputSchema: { contentIds: z.array(z.string().min(1)).min(1).max(100) },
      annotations: { destructiveHint: true },
    },
    ({ contentIds }) =>
      run(async () => {
        const client = await art();
        await client.delete(contentIds);
        return text(`Asked the TV to delete ${contentIds.length} item${contentIds.length === 1 ? '' : 's'}.`);
      }),
  );

  server.registerTool(
    'frame_favorite_art',
    {
      title: 'Mark artwork as favourite',
      description: 'Add an artwork to, or remove it from, the Favorites collection.',
      inputSchema: { contentId: z.string().min(1), favorite: z.boolean() },
    },
    ({ contentId, favorite }) =>
      run(async () => {
        const client = await art();
        await client.setFavorite(contentId, favorite);
        return text(`${contentId} is ${favorite ? 'now' : 'no longer'} a favourite.`);
      }),
  );

  server.registerTool(
    'frame_art_thumbnail',
    {
      title: 'Preview an artwork',
      description: 'Fetch a small preview image of an artwork so you can see what a content id is.',
      inputSchema: { contentId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    ({ contentId }) =>
      run(async () => {
        const client = await art();
        const [file] = await client.getThumbnails([contentId]);

        if (!file) {
          return { isError: true, content: [{ type: 'text', text: `The TV has no preview for ${contentId}.` }] };
        }

        return {
          content: [{ type: 'image', data: file.data.toString('base64'), mimeType: file.type === 'png' ? 'image/png' : 'image/jpeg' }],
        };
      }),
  );

  server.registerTool(
    'frame_art_settings',
    {
      title: 'Read or change Art Mode settings',
      description:
        'With no arguments, report Art Mode settings (brightness 0-10, colour tone -5 to 5, and others the TV exposes). Pass brightness and/or colorTemperature to change them.',
      inputSchema: {
        brightness: z.number().int().min(0).max(10).optional(),
        colorTemperature: z.number().int().min(-5).max(5).optional(),
      },
    },
    ({ brightness, colorTemperature }) =>
      run(async () => {
        const client = await art();

        if (brightness !== undefined) {
          await client.setBrightness(brightness);
        }

        if (colorTemperature !== undefined) {
          await client.setColorTemperature(colorTemperature);
        }

        const settings = await client.getSettings();
        return text(Object.fromEntries(settings.map((setting) => [setting.item, setting.value])));
      }),
  );

  server.registerTool(
    'frame_slideshow',
    {
      title: 'Read or set the slideshow',
      description:
        'With no arguments, report the slideshow setting. Pass minutes to rotate artwork automatically (0 turns it off). The TV only accepts certain intervals and rejects others.',
      inputSchema: {
        minutes: z.number().int().min(0).optional(),
        shuffle: z.boolean().optional(),
        collection: z.enum(['photos', 'favorites']).optional(),
      },
    },
    ({ minutes, shuffle, collection: which }) =>
      run(async () => {
        const client = await art();

        if (minutes !== undefined) {
          await client.setSlideshow({ minutes, shuffle, categoryId: COLLECTIONS[which ?? 'photos'] });
        }

        const status = await client.getSlideshow();
        return text({ interval: status.value, collection: status.category_id, type: status.type });
      }),
  );

  server.registerTool(
    'frame_list_mattes',
    {
      title: 'List mattes',
      description: 'List the matte styles and colours the TV offers. A matte id is "<style>_<colour>", e.g. "shadowbox_polar", or "none".',
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const client = await art();
        return text(await client.getMatteList());
      }),
  );

  server.registerTool(
    'frame_set_matte',
    {
      title: 'Change an artwork matte',
      description: 'Change the matte (border) of an uploaded image. Not every matte suits every image size; the TV rejects ones that do not.',
      inputSchema: { contentId: z.string().min(1), matte: z.string().min(1) },
    },
    ({ contentId, matte }) =>
      run(async () => {
        const client = await art();
        await client.changeMatte(contentId, matte);
        return text(`Matte for ${contentId} set to ${matte}.`);
      }),
  );

  return server;
}

/** Read an image for upload, refusing anything that is not a reasonably sized JPEG or PNG in an allowed place. */
export async function readImage(path: string, allowedDirs: string[] | undefined, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) {
    throw new Error('Give an absolute file path.');
  }

  let resolved: string;

  try {
    // Resolve symlinks so a link inside an allowed folder cannot point outside it.
    resolved = await realpath(path);
  } catch {
    throw new Error(`No file found at ${path}.`);
  }

  if (allowedDirs?.length) {
    const roots = await Promise.all(allowedDirs.map((dir) => realpath(resolve(dir)).catch(() => resolve(dir))));
    const inside = roots.some((root) => resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep));

    if (!inside) {
      throw new Error(`Uploads are limited to: ${allowedDirs.join(', ')}.`);
    }
  }

  const info = await stat(resolved);

  if (!info.isFile()) {
    throw new Error(`${path} is not a file.`);
  }

  if (info.size > maxBytes) {
    throw new Error(`The file is ${(info.size / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }

  const image = await readFile(resolved);
  detectImageType(image);

  return image;
}
