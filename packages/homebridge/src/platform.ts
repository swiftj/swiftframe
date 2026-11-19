import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { FileTokenStore, FrameTV, type Logger } from 'swiftframe-core';
import { normalizeTvConfigs, PLUGIN_NAME } from './config.js';
import { TvAccessory } from './tv-accessory.js';

export class SwiftFramePlatform implements DynamicPlatformPlugin {
  private readonly accessories: TvAccessory[] = [];

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => this.launch());
    this.api.on('shutdown', () => this.accessories.forEach((accessory) => accessory.destroy()));
  }

  /** TVs are published as external accessories, so Homebridge never restores any from its cache. */
  configureAccessory(_accessory: PlatformAccessory): void {}

  private launch(): void {
    const tvs = normalizeTvConfigs(this.config.tvs, (message) => this.log.warn(message));

    if (tvs.length === 0) {
      this.log.warn('No TVs are configured. Add one in the plugin settings.');
      return;
    }

    for (const config of tvs) {
      const logger = this.loggerFor(config.name);
      const tokenFile = join(this.api.user.storagePath(), 'swiftframe', `${config.ip.replace(/[^a-zA-Z0-9.-]/g, '_')}.token`);

      const tv = new FrameTV({
        host: config.ip,
        mac: config.mac,
        clientName: 'Homebridge',
        tokenStore: new FileTokenStore(tokenFile),
        pollIntervalMs: config.pollInterval * 1000,
        logger,
      });

      const accessory = new TvAccessory(this.api, logger, config, tv);
      this.accessories.push(accessory);

      // A Television must be its own accessory for Home to show it as a TV with a remote.
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory.platformAccessory]);
      logger.info(`Published. In the Home app choose Add Accessory > More options and select "${config.name}".`);

      void accessory.start();
    }
  }

  private loggerFor(name: string): Logger {
    const prefix = `[${name}]`;

    return {
      debug: (message, ...args) => this.log.debug(`${prefix} ${message}`, ...args),
      info: (message, ...args) => this.log.info(`${prefix} ${message}`, ...args),
      warn: (message, ...args) => this.log.warn(`${prefix} ${message}`, ...args),
      error: (message, ...args) => this.log.error(`${prefix} ${message}`, ...args),
    };
  }
}
