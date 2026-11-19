import type { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './config.js';
import { SwiftFramePlatform } from './platform.js';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SwiftFramePlatform);
};
