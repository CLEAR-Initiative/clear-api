/**
 * Favicon + app-icon tags for HTML surfaces.
 *
 * Assets live in `public/` (`favicon.ico`, `apple-touch-icon.png`,
 * `android-chrome-*.png`, `site.webmanifest`). Keep this the only place
 * that names those files in `<head>`.
 */
export function renderIconLinks(): string {
  return `<link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">`;
}
