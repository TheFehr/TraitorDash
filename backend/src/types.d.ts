declare module 'alpinejs' {
  const Alpine: any;
  export default Alpine;
}

declare module 'fengari' {
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(str: string): Uint8Array;
  export function to_jsstring(bytes: Uint8Array | number[]): string;
}

// The Khronos glTF validator (a development dependency, used by the tests) ships no types.
declare module 'gltf-validator' {
  const validator: { validateBytes(data: Uint8Array, options?: unknown): Promise<any> }
  export default validator
}
