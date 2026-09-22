import { SERVICE_UUID_STR, NOTIFY_CHAR_UUID_STR, KNOWN_SERVICE_UUIDS } from './protocol';
import {
  pickWritable,
  saveRemembered,
  forgetRemembered,
  propsOf,
  type MatchPath,
} from './gattPick';
import type { Transport, ConnectOptions } from './transport';

/** One row of the connected device's GATT table, for the diagnostics panel. */
export interface GattEntry {
  service: string;
  characteristic: string;
  props: string;
  chosen: boolean;
}

/** How the write characteristic was picked — a fallback match is a red flag. */
export type { MatchPath } from './gattPick';

export type WriteMode = 'with-response' | 'without-response';

/**
 * Web Bluetooth transport — desktop Chrome / Edge / Brave (flag) / Android Chrome.
 * Not available in iOS Safari; the iOS build uses the Capacitor transport.
 */
export class WebBluetoothTransport implements Transport {
  readonly name = 'Web Bluetooth';
  private device?: BluetoothDevice;
  private characteristic?: BluetoothRemoteGATTCharacteristic;
  private disconnectCb?: () => void;
  /** Serialises writes — concurrent GATT writes throw "operation already in progress". */
  private queue: Promise<unknown> = Promise.resolve();

  /** Full GATT table from the last connect, so the UI can show what was found. */
  gatt: GattEntry[] = [];
  matchPath?: MatchPath;
  /** The service/characteristic actually in use. */
  chosenPair?: { service: string; characteristic: string };
  /** Bytes the printer sent back on the notify characteristic, if any. */
  notifications: string[] = [];

  /**
   * `with-response` lets Chrome perform a long write, so chunks larger than the
   * ATT MTU still get through. `without-response` is faster but CANNOT be split:
   * anything over MTU-3 (as little as 20 bytes) may fail silently.
   */
  writeMode: WriteMode = 'with-response';

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  isConnected(): boolean {
    return !!this.device?.gatt?.connected && !!this.characteristic;
  }

  /** True when we only found a characteristic by brute force — likely wrong. */
  isUncertain(): boolean {
    return this.matchPath === 'brute-force';
  }

  async connect(opts: ConnectOptions = {}): Promise<string> {
    if (!WebBluetoothTransport.isSupported()) {
      throw new Error(
        'Web Bluetooth unavailable. Chrome/Edge work out of the box; Brave needs ' +
          'brave://flags/#brave-web-bluetooth-api enabled.',
      );
    }

    // Filtering hides printers that don't advertise their service UUID in the
    // advertising packet (common — the service is often only visible after
    // connecting). `allDevices` shows everything nearby instead.
    this.device = await navigator.bluetooth.requestDevice(
      opts.allDevices
        ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID_STR, ...KNOWN_SERVICE_UUIDS] }
        : {
            filters: [
              { services: [SERVICE_UUID_STR] },
              { namePrefix: 'M110' },
              { namePrefix: 'M120' },
              { namePrefix: 'M220' },
              { namePrefix: 'M200' },
            ],
            optionalServices: [SERVICE_UUID_STR, ...KNOWN_SERVICE_UUIDS],
          },
    );

    this.device.addEventListener('gattserverdisconnected', () => {
      this.characteristic = undefined;
      this.disconnectCb?.();
    });

    const server = await this.device.gatt!.connect();
    await this.discover(server);

    if (!this.characteristic) {
      throw new Error(
        `Connected, but found no writable characteristic. ${this.gatt.length} GATT ` +
          'entries discovered — see Connection details.',
      );
    }

    await this.subscribeNotify(server);
    return this.device.name || 'Phomemo printer';
  }

  /**
   * Enumerate the whole GATT table, then choose a write characteristic.
   *
   * The table is always built in full (not just until a match) so a wrong guess
   * is visible rather than silently reported as a successful connection.
   */
  private async discover(server: BluetoothRemoteGATTServer): Promise<void> {
    this.gatt = [];
    this.matchPath = undefined;
    this.characteristic = undefined;

    // `getPrimaryServices` only returns services the browser is allowed to see,
    // which is why every candidate UUID must be in `optionalServices` above.
    const services = await server.getPrimaryServices().catch(() => []);
    const table: { svc: string; ch: BluetoothRemoteGATTCharacteristic }[] = [];

    for (const svc of services) {
      const chars = await svc.getCharacteristics().catch(() => []);
      for (const ch of chars) {
        const props = Object.entries(ch.properties)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(',');
        this.gatt.push({ service: svc.uuid, characteristic: ch.uuid, props, chosen: false });
        table.push({ svc: svc.uuid, ch });
      }
    }

    const { chosen, matchPath } = pickWritable(
      table.map((e) => ({
        service: e.svc,
        characteristic: e.ch.uuid,
        writable: e.ch.properties.write || e.ch.properties.writeWithoutResponse,
        props: propsOf(e.ch.properties as unknown as Record<string, unknown>),
        ref: e.ch,
      })),
    );
    this.matchPath = matchPath;

    if (chosen) {
      this.characteristic = chosen.ref;
      this.chosenPair = { service: chosen.service, characteristic: chosen.characteristic };
      const row = this.gatt.find(
        (g) => g.service === chosen.service && g.characteristic === chosen.characteristic,
      );
      if (row) row.chosen = true;
    }
  }

  /** Record the pair that worked, so the next connect targets it directly. */
  confirmWorking(): void {
    if (this.chosenPair) saveRemembered(this.chosenPair);
  }

  forgetRemembered(): void {
    forgetRemembered();
  }

  /**
   * Subscribe to the notify characteristic. Some firmware only starts accepting
   * raster data once notifications are enabled, and the replies are useful
   * evidence that the printer is actually listening.
   */
  private async subscribeNotify(server: BluetoothRemoteGATTServer): Promise<void> {
    this.notifications = [];
    try {
      const svc = await server.getPrimaryService(SERVICE_UUID_STR);
      const ch = await svc.getCharacteristic(NOTIFY_CHAR_UUID_STR);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (ev) => {
        const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!v) return;
        const hex = [...new Uint8Array(v.buffer)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        this.notifications.push(hex);
      });
    } catch {
      // Not fatal — plenty of units print without it.
    }
  }

  async disconnect(): Promise<void> {
    this.characteristic = undefined;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  write(data: Uint8Array): Promise<void> {
    const char = this.characteristic;
    if (!char) return Promise.reject(new Error('Printer not connected'));

    // Chain onto the queue so writes land strictly in order.
    const run = this.queue.then(async () => {
      // Copy into a fresh buffer: a subarray view of a larger ArrayBuffer makes
      // some Chrome versions send the whole backing buffer.
      const buf = new Uint8Array(data.length);
      buf.set(data);

      const preferNoResponse =
        this.writeMode === 'without-response' && char.properties.writeWithoutResponse;

      if (preferNoResponse && char.writeValueWithoutResponse) {
        await char.writeValueWithoutResponse(buf);
      } else if (char.properties.write && char.writeValueWithResponse) {
        await char.writeValueWithResponse(buf);
      } else {
        await char.writeValue(buf);
      }
    });
    // Keep the chain alive even if one write rejects.
    this.queue = run.catch(() => {});
    return run;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }
}
