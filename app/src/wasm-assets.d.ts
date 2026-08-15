/**
 * `?url` imports, which Vite turns into a bundled asset path.
 *
 * Used for the QR decoder's WebAssembly binary. zxing-wasm would otherwise
 * fetch it from a CDN at runtime, which in this app would be remote code
 * arriving in the process that talks to a signing device -- and would be
 * blocked by the CSP in any case. The import makes it a local asset served
 * from 'self' like everything else the app ships.
 */
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
