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
  // Must be, character for character, the redirect URI the app was
  // registered with: SoundCloud compares the strings and answers a blank
  // sign-in page otherwise. Its app form keeps the URI without a scheme
  // or trailing slash, so this is the registered form of the deployed
  // page, `https://aj8uppal.github.io/murmuration/`; GitHub Pages turns the
  // bare path into the directory URL, query and all. For local work,
  // register `http://localhost:8173/` and set this to match.
  redirectUri: 'aj8uppal.github.io/murmuration',
};
