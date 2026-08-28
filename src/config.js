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
  // The page's own URL, as a directory: the same string whether it was
  // opened as `/` or `/index.html`. Register exactly this with the app -
  // `http://localhost:8173/` for local work, and the deployed page's URL,
  // for example `https://aj8uppal.github.io/murmuration/`.
  redirectUri: `${location.origin}${location.pathname.replace(/index\.html$/, '')}`,
};
