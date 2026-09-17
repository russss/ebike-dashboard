/** A hand-rolled `BluetoothRemoteGATTCharacteristic` fake, shared by bike.test.ts and transport.test.ts. */
import { vi } from "vitest";

export interface FakeCharacteristic {
  uuid: string;
  properties: { write?: boolean; writeWithoutResponse?: boolean; notify?: boolean };
  writeValueWithResponse: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  startNotifications: ReturnType<typeof vi.fn>;
  value?: DataView;
  emit(data: Uint8Array): void;
}

export function makeFakeCharacteristic(uuid: string, notify: boolean): FakeCharacteristic {
  const listeners: ((event: Event) => void)[] = [];
  const char: FakeCharacteristic = {
    uuid,
    properties: notify ? { notify: true } : { write: true },
    writeValueWithResponse: vi.fn().mockResolvedValue(undefined),
    addEventListener: (_type, listener) => listeners.push(listener),
    startNotifications: vi.fn().mockResolvedValue(undefined),
    emit(data: Uint8Array) {
      char.value = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (const listener of listeners) listener({ target: char } as unknown as Event);
    },
  };
  return char;
}
