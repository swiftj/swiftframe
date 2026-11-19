import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FrameTV, MemoryTokenStore } from 'swiftframe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTv } from '../../core/test/mock-tv.js';
import { createServer, readImage } from '../src/server.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 3)]);

let tv: MockTv;
let frame: FrameTV;
let client: Client;
let dir: string;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  };

  const first = result.content[0]!;
  let json: any;

  try {
    json = first.text ? JSON.parse(first.text) : undefined;
  } catch {
    json = undefined;
  }

  return { isError: result.isError === true, text: first.text ?? '', json, first };
};

beforeEach(async () => {
  tv = new MockTv();
  await tv.start();

  dir = mkdtempSync(join(tmpdir(), 'swiftframe-'));
  frame = new FrameTV({ host: '127.0.0.1', tokenStore: new MemoryTokenStore(), transport: tv.transport });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(frame, { uploadDirs: [dir] }).connect(serverTransport);

  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  frame.stop();
  await tv.stop();
});

describe('swiftframe MCP server', () => {
  it('offers the full tool set with descriptions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining(['frame_status', 'frame_power', 'frame_art_mode', 'frame_list_art', 'frame_upload_art', 'frame_slideshow']),
    );
    expect(tools.every((tool) => (tool.description ?? '').length > 20)).toBe(true);
    expect(tools.find((tool) => tool.name === 'frame_delete_art')?.annotations?.destructiveHint).toBe(true);
  });

  it('reports status without needing to pair', async () => {
    const { json } = await call('frame_status');
    expect(json).toMatchObject({ status: 'on', paired: false, model: 'QN55LS03BAFXZA', firmware: '1720', isFrame: true });
  });

  it('pairs on first use and switches Art Mode', async () => {
    const { isError, text } = await call('frame_art_mode', { on: true });

    expect(isError).toBe(false);
    expect(text).toContain('on');
    expect(tv.artMode).toBe(true);
    expect(frame.isPaired).toBe(true);
  });

  it('lists uploaded photos by default and other collections on request', async () => {
    expect((await call('frame_list_art')).json.count).toBe(2);
    expect((await call('frame_list_art', { collection: 'all' })).json.count).toBe(3);
    expect((await call('frame_list_art', { collection: 'favorites' })).json.artwork[0].contentId).toBe('SAM-F0100');
  });

  it('uploads an image, shows it, and enters Art Mode', async () => {
    const path = join(dir, 'autumn.png');
    writeFileSync(path, PNG);

    const { json, isError } = await call('frame_upload_art', { path, matte: 'shadowbox_polar' });

    expect(isError).toBe(false);
    expect(json).toEqual({ contentId: 'MY_F1001', shown: true });
    expect(tv.uploads[0]?.equals(PNG)).toBe(true);
    expect(tv.current).toBe('MY_F1001');
    expect(tv.artMode).toBe(true);
  });

  it('refuses uploads from outside the allowed folders, including through a symlink', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 'secret.png');
    writeFileSync(outside, PNG);
    symlinkSync(outside, join(dir, 'link.png'));

    expect((await call('frame_upload_art', { path: outside })).isError).toBe(true);
    expect((await call('frame_upload_art', { path: join(dir, 'link.png') })).isError).toBe(true);
    expect(tv.uploads).toHaveLength(0);
  });

  it('refuses files that are not images', async () => {
    const path = join(dir, 'notes.png');
    writeFileSync(path, 'these are my private notes');

    const { isError, text } = await call('frame_upload_art', { path });
    expect(isError).toBe(true);
    expect(text).toMatch(/JPEG and PNG/);
    await expect(readImage('relative.png', undefined, 1000)).rejects.toThrow(/absolute/);
  });

  it('reads and changes brightness, slideshow and volume', async () => {
    expect((await call('frame_art_settings', { brightness: 8 })).json.brightness).toBe('8');
    expect((await call('frame_slideshow', { minutes: 15, collection: 'favorites' })).json).toMatchObject({
      interval: '15',
      collection: 'MY-C0004',
    });
    expect((await call('frame_volume', { level: 20, mute: true })).json).toEqual({ volume: 20, muted: true });
  });

  it('returns an artwork preview as an image', async () => {
    const { first } = await call('frame_art_thumbnail', { contentId: 'MY_F0002' });

    expect(first.type).toBe('image');
    expect(Buffer.from(first.data!, 'base64').toString()).toBe('thumbnail:MY_F0002');
  });

  it('sends keys and deletes artwork', async () => {
    await call('frame_send_keys', { keys: ['home', 'KEY_ENTER'] });
    // The TV handles keys asynchronously after the send is acknowledged.
    await vi.waitFor(() => expect(tv.keys.map((entry) => entry.key)).toEqual(['KEY_HOME', 'KEY_ENTER']));

    await call('frame_delete_art', { contentIds: ['MY_F0001'] });
    expect(tv.artwork.map((item) => item.content_id)).not.toContain('MY_F0001');
  });

  it('explains failures instead of throwing', async () => {
    tv.online = false;

    const status = await call('frame_status');
    expect(status.json.status).toBe('off');

    const power = await call('frame_power', { power: 'on' });
    expect(power.isError).toBe(true);
    expect(power.text.length).toBeGreaterThan(10);
  });

  it('says so when the TV is not a Frame', async () => {
    tv.frameSupport = false;

    const { isError, text } = await call('frame_list_art');
    expect(isError).toBe(true);
    expect(text).toMatch(/Art Mode/);
  });
});
