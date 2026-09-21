/**
 * Transport abstraction.
 *
 * Everything above this interface is platform-agnostic, which is the whole
 * point: the Web Bluetooth implementation runs in desktop Chrome today, and an
 * iOS build swaps in a CoreBluetooth-backed one (@capacitor-community/bluetooth-le)
 * without touching the protocol, renderer or UI.
 */
export interface ConnectOptions {
  /** Show every nearby BLE device instead of filtering on Phomemo UUIDs/names. */
  allDevices?: boolean;
}

export interface Transport {
  readonly name: string;
  /** True once a printer is connected and writable. */
  isConnected(): boolean;
  /** Prompt for / connect to a printer. Resolves with a display name. */
  connect(opts?: ConnectOptions): Promise<string>;
  disconnect(): Promise<void>;
  /** Write one GATT payload. Callers chunk to CHUNK_SIZE before calling. */
  write(data: Uint8Array): Promise<void>;
  /** Called between chunks so an implementation can pace itself. */
  onDisconnect(cb: () => void): void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
