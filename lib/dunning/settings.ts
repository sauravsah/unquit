/**
 * A founder's dunning settings: on/off, the 3-day schedule, the sender name
 * and the email templates. Parsed and validated here; stored in
 * `dunning_settings` (migration 0003). No row = defaults, switched OFF, so
 * nothing is emailed to a founder's customers until they turn it on.
 */
import { DEFAULT_SCHEDULE_DAYS, MAX_SCHEDULE_DAY, isValidSchedule, type ScheduleDays } from "./schedule";
import { parseTemplates, resolveTemplates, templateOverrides, type TemplateSet } from "./templates";

export type DunningSettings = {
  enabled: boolean;
  scheduleDays: ScheduleDays;
  companyName: string | null;
  replyToEmail: string | null;
  templates: TemplateSet;
};

export type DunningSettingsRow = {
  enabled: boolean;
  schedule_days: number[];
  company_name: string | null;
  reply_to_email: string | null;
  templates: unknown;
};

export const SETTINGS_COLUMNS = "enabled, schedule_days, company_name, reply_to_email, templates";

export function settingsFromRow(row: DunningSettingsRow | null): DunningSettings {
  if (!row) {
    return { enabled: false, scheduleDays: DEFAULT_SCHEDULE_DAYS, companyName: null, replyToEmail: null, templates: resolveTemplates(null) };
  }
  const days = (row.schedule_days ?? []).map(Number);
  return {
    enabled: !!row.enabled,
    scheduleDays: isValidSchedule(days) ? (days as unknown as ScheduleDays) : DEFAULT_SCHEDULE_DAYS,
    companyName: row.company_name,
    replyToEmail: row.reply_to_email,
    templates: resolveTemplates(row.templates),
  };
}

export function settingsToRow(s: DunningSettings): DunningSettingsRow {
  return {
    enabled: s.enabled,
    schedule_days: [...s.scheduleDays],
    company_name: s.companyName,
    reply_to_email: s.replyToEmail,
    templates: templateOverrides(s.templates),
  };
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Validates what the dashboard sends. */
export function parseDunningSettings(input: unknown): { ok: true; value: DunningSettings } | { ok: false; errors: string[] } {
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["Send the settings as JSON."] };
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  const enabled = raw.enabled === true;

  const days = Array.isArray(raw.scheduleDays) ? raw.scheduleDays.map((d) => Number(d)) : null;
  if (!isValidSchedule(days)) {
    errors.push(`The schedule needs 3 whole days in increasing order, between 0 and ${MAX_SCHEDULE_DAY} (for example 0, 3, 7).`);
  }

  let companyName: string | null = null;
  if (typeof raw.companyName === "string" && raw.companyName.trim() !== "") {
    companyName = raw.companyName.trim().replace(/\s+/g, " ");
    if (companyName.length > 100) errors.push("The company name is over 100 characters.");
    if (/[<>"\\]/.test(companyName)) errors.push("The company name can't contain < > \" or \\.");
  }
  if (enabled && !companyName) errors.push("Add your company name before turning emails on: it's the sender name customers see.");

  let replyToEmail: string | null = null;
  if (typeof raw.replyToEmail === "string" && raw.replyToEmail.trim() !== "") {
    replyToEmail = raw.replyToEmail.trim();
    if (replyToEmail.length > 254 || !EMAIL.test(replyToEmail)) errors.push("The reply-to address doesn't look like an email address.");
  }

  const templates = parseTemplates(raw.templates);
  if (!templates.ok) errors.push(...templates.errors);

  if (errors.length > 0 || !templates.ok) return { ok: false, errors };
  return {
    ok: true,
    value: { enabled, scheduleDays: days as unknown as ScheduleDays, companyName, replyToEmail, templates: templates.value },
  };
}
