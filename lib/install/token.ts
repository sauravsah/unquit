/**
 * Shareable developer setup links: /install/<token>.
 *
 * The token is 64 random hex characters from Postgres' strong RNG
 * (new_install_link_token() in 0007_install_links.sql), stored on the account.
 * It is never derived from the account id, so it can't be guessed, and a
 * founder can rotate it to kill an old link. This module only checks the shape
 * so a malformed token never reaches the database.
 */

export const INSTALL_TOKEN_PATTERN = /^uqi_[0-9a-f]{64}$/;

export function isInstallToken(value: unknown): value is string {
  return typeof value === "string" && INSTALL_TOKEN_PATTERN.test(value);
}

/** Absolute URL of the public developer page. */
export function installLinkUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/install/${token}`;
}
