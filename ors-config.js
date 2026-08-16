/* Fill this in with your own OpenRouteService API key to turn on navigation
 * (a route + distance/ETA drawn to a saved place). Sign up free at
 * https://openrouteservice.org/dev/#/signup, then Dashboard → Request a
 * token → Standard — the token it gives you is the string that goes below.
 *
 * Unlike firebase-config.js, this key is tied to a personal request quota
 * (2,000 requests/day on the free tier) rather than being safe-by-design to
 * publish — treat it the way you'd treat any other API key, and don't commit
 * a real one to a public repo. Local development or a private deployment is
 * fine; for a public site, inject it at deploy time instead of hardcoding it
 * here.
 *
 * Until you replace PLACEHOLDER below, the "Navigate" option on saved places
 * stays hidden and the rest of the app is unaffected.
 */
window.WHEREABOUTS_ORS_CONFIG = {
  apiKey: "PLACEHOLDER"
};
