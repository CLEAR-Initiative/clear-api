/**
 * Pure policy helpers for groundSources CRUD — the per-source policy
 * record every ingest is gated on (WhatsApp Signal Pipeline PRD §3.6).
 *
 * The V2 requirement made honest here: a GROUP source's policy record
 * must carry a complete consent record — what was consented to
 * (consentScope), when it was recorded (consentRecordedAt), and who
 * consented (consentRecordedBy). Group rows without all three cannot be
 * created, and existing incomplete rows cannot be modified without
 * completing them. The hotline kind is exempt: hotline consent is
 * explicit by design (the submitter chooses to message the number), so
 * its policy record carries no group-consent fields.
 *
 * Note this is record-keeping validation, not the live-capture consent
 * GATE — that stricter check (active + scope actually covering message
 * content) lives in ground-live-ingest.ts and is applied per payload.
 */

export const GROUND_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "staff_group",
  "partner_group",
  "hotline",
]);

/** Kinds whose policy record requires a complete recorded consent. */
export const GROUP_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "staff_group",
  "partner_group",
]);

export interface ConsentFields {
  consentScope: string | null;
  consentRecordedAt: Date | null;
  consentRecordedBy: string | null;
}

/**
 * Names of the consent fields a source of `kind` is missing. Empty array
 * means the record is valid. Whitespace-only text counts as missing —
 * a consent record you cannot read is not a record.
 */
export function missingConsentFields(kind: string, fields: ConsentFields): string[] {
  if (!GROUP_SOURCE_KINDS.has(kind)) return [];
  const missing: string[] = [];
  if (!fields.consentScope || fields.consentScope.trim() === "") {
    missing.push("consentScope");
  }
  if (!fields.consentRecordedAt) missing.push("consentRecordedAt");
  if (!fields.consentRecordedBy || fields.consentRecordedBy.trim() === "") {
    missing.push("consentRecordedBy");
  }
  return missing;
}
