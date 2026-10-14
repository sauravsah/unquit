/** Google Analytics 4 measurement id (public). */
export const GA_MEASUREMENT_ID = "G-WMZH2G7YHL";

/**
 * Public pages where Google Analytics may run. Everywhere else (the dashboard,
 * admin, the card-update pages end customers see, developer setup links) it is
 * switched off, as the Privacy Policy promises.
 */
export const ANALYTICS_PATHS = ["/", "/signup", "/login", "/terms", "/privacy", "/data-use"] as const;

export function analyticsAllowed(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (ANALYTICS_PATHS as readonly string[]).includes(path);
}
