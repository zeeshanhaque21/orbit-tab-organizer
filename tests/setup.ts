/**
 * Minimal in-memory `chrome` mock so the modules under test can be imported in
 * Node. Only the surface the extension actually touches is implemented.
 */
import { vi } from "vitest"

type Store = Record<string, unknown>

const memory: Store = {}

const local = {
  async get(keys?: string | string[] | null): Promise<Store> {
    if (keys == null) return { ...memory }
    const list = Array.isArray(keys) ? keys : [keys]
    const out: Store = {}
    for (const k of list) if (k in memory) out[k] = memory[k]
    return out
  },
  async set(items: Store): Promise<void> {
    Object.assign(memory, items)
  },
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete memory[k]
  },
  async clear(): Promise<void> {
    for (const k of Object.keys(memory)) delete memory[k]
  },
}

const session = { ...local }

const chromeMock = {
  storage: {
    local,
    session,
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    id: "test-extension-id",
    getManifest: () => ({ version: "2.10.0" }),
    getURL: (p: string) => `chrome-extension://test/${p}`,
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    openOptionsPage: vi.fn(),
  },
  tabs: {
    query: vi.fn(async () => []),
    get: vi.fn(async () => ({})),
    create: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => ({})),
    move: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    group: vi.fn(async () => 1),
    ungroup: vi.fn(async () => undefined),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onActivated: { addListener: vi.fn() },
    onMoved: { addListener: vi.fn() },
    onAttached: { addListener: vi.fn() },
    onDetached: { addListener: vi.fn() },
    onReplaced: { addListener: vi.fn() },
  },
  tabGroups: {
    query: vi.fn(async () => []),
    get: vi.fn(async () => null),
    update: vi.fn(async () => ({})),
    onUpdated: { addListener: vi.fn() },
  },
  windows: {
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    getAll: vi.fn(async () => [{ id: 1 }]),
    getCurrent: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => ({})),
    create: vi.fn(async () => ({ id: 2 })),
  },
  commands: { onCommand: { addListener: vi.fn() } },
  contextMenus: {
    create: vi.fn(),
    removeAll: vi.fn(async () => undefined),
    onClicked: { addListener: vi.fn() },
  },
  action: { openPopup: vi.fn(async () => undefined) },
  scripting: { executeScript: vi.fn(async () => []) },
}

// @ts-expect-error - injecting the mock into the global scope
globalThis.chrome = chromeMock

export { chromeMock, memory }
