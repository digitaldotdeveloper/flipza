/**
 * Resolves a runtime asset (a frame, the logo) to something the browser can
 * actually load.
 *
 * Normally that is just a URL under the Vite base. The standalone build has no
 * server and no origin to load from - opened over `file://`, a `fetch()` of a
 * sibling file is a cross-origin request and is refused - so instead it inlines
 * every asset as a data URI on `__FLIPZA_ASSETS__` before the bundle runs, and
 * this lookup finds them there.
 */
declare global {
  interface Window {
    __FLIPZA_ASSETS__?: Record<string, string>
  }
}

export const asset = (name: string): string =>
  window.__FLIPZA_ASSETS__?.[name] ?? `${import.meta.env.BASE_URL}${name}`
