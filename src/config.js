/**
 * SoundCloud. Playing a SoundCloud link needs an app registered at
 * developers.soundcloud.com (an Artist Pro account is required to register
 * one), with this page's URL among its redirect URIs. Put the app's client
 * id here, or in localStorage under `murmuration.soundcloud.clientId`. The
 * client id is public by design - the sign-in is OAuth 2.1 with PKCE and no
 * secret ever reaches the browser. Without it the SoundCloud button explains
 * itself and offers tab capture instead.
 */
export const SOUNDCLOUD = {
  clientId: '1RFTFW4l52Sh1Vii1F2yWx7o2O2E62n9',
  // SoundCloud requires the client secret for the token exchange even with
  // PKCE, and the secret cannot live on a public page. `tokenProxy` is the
  // URL of the worker in tools/soundcloud-proxy, which holds it; the page
  // sends the code and verifier there and gets the tokens back. Empty, the
  // page calls SoundCloud directly, which works only with a secret in
  // localStorage under `murmuration.soundcloud.clientSecret` - for a local
  // test on your own machine, never for a deployed page.
  tokenProxy: '',
  // The page's own URL, as a directory: the same string whether it was
  // opened as `/` or `/index.html`. It must match the app's registered
  // redirect URI character for character - scheme and trailing slash
  // included - or SoundCloud answers a blank sign-in page. Register
  // `https://aj8uppal.github.io/murmuration/` for the deployed page and
  // `http://localhost:8173/` for local work.
  redirectUri: `${location.origin}${location.pathname.replace(/index\.html$/, '')}`,
};
