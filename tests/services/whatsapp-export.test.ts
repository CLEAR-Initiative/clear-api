/**
 * Parser tests for the WhatsApp chat-export format.
 *
 * The fixture below is SYNTHETIC — invented senders, places, and content
 * that mimic the real export format byte-for-byte (CRLF line endings,
 * U+200E left-to-right marks, U+202F narrow no-break space after the `~`
 * non-contact prefix, `<attached: …>` and `… omitted` media markers,
 * `<This message was edited>`, system messages, multi-line bodies). No
 * real chat content appears here.
 *
 * Pure unit tests — no DB, always run.
 */

import { describe, it, expect } from "vitest";
import {
  deriveExternalId,
  deriveSenderRef,
  extractUncertaintyMarker,
  parseWhatsAppExport,
  PHONE_REDACTION_PLACEHOLDER,
  redactPhoneNumbers,
  withExternalIds,
} from "../../src/services/whatsapp-export.js";

const LRM = "‎";
const NNBSP = " ";

/** Synthetic export covering every observed format quirk:
 *  - encryption notice + "added" + group-name-change system messages
 *  - a multi-message incident: report → location correction → retraction
 *  - an edited message
 *  - captioned media (attached), caption-less media (attached), and
 *    caption-less omitted media
 *  - a multi-line message
 *  - a deleted-message placeholder
 *  - a phone number (redaction is asserted separately, at persistence)
 */
const FIXTURE = [
  `[01.04.26, 09:00:00] Field Updates Test Group: ${LRM}Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.`,
  `[01.04.26, 09:00:05] Field Updates Test Group: ${LRM}Adam Example added you`,
  `[02.04.26, 07:15:00] ~${NNBSP}Basma: Reported drone strike at the water point in Kolme village this morning, several structures hit`,
  `[02.04.26, 07:31:10] ~${NNBSP}Basma: Correction - the strike was at the market in Dorti, not Kolme ${LRM}<This message was edited>`,
  `[02.04.26, 08:02:44] Chris Sample: Unconfirmed reports of a second strike on the same road`,
  `[03.04.26, 10:12:00] ~${NNBSP}Basma: Update on yesterday - this turned out to be misreporting, no strikes at either location`,
  `${LRM}[03.04.26, 11:00:00] Chris Sample: Road assessment attached ${LRM}<attached: 00000001-report-road-assessment.pdf>`,
  `${LRM}[03.04.26, 11:00:30] Chris Sample: ${LRM}<attached: 00000002-PHOTO-2026-04-03-11-00-30.jpg>`,
  `${LRM}[03.04.26, 11:01:00] ~${NNBSP}Basma: ${LRM}image omitted`,
  `[03.04.26, 12:30:00] Dina Test: Contact the focal point on +249 91 234 5678 for access updates`,
  `[04.04.26, 06:45:00] Dina Test: Two things from the morning briefing:`,
  `1. The corridor reopens at noon`,
  `2. Convoys must register first`,
  `[04.04.26, 07:00:00] ~${NNBSP}Basma: ${LRM}This message was deleted.`,
  `[04.04.26, 07:30:00] Field Updates Test Group: ${LRM}Adam Example changed the group name`,
].join("\r\n");

describe("parseWhatsAppExport", () => {
  const messages = parseWhatsAppExport(FIXTURE);

  it("filters system messages and deleted placeholders, keeps real messages", () => {
    // 15 lines → 2 system at top, 1 deleted, 1 group-name change filtered;
    // the two numbered continuation lines fold into one message.
    expect(messages).toHaveLength(9);
    const texts = messages.map((m) => m.text);
    expect(texts.some((t) => t.includes("end-to-end encrypted"))).toBe(false);
    expect(texts.some((t) => t.includes("added you"))).toBe(false);
    expect(texts.some((t) => t.includes("changed the group name"))).toBe(false);
    expect(texts.some((t) => t.includes("This message was deleted"))).toBe(false);
  });

  it("parses timestamp, sender, and text of a plain message", () => {
    const first = messages[0]!;
    expect(first.sentAt.toISOString()).toBe("2026-04-02T07:15:00.000Z");
    expect(first.senderName).toBe("Basma"); // ~ + narrow-nbsp prefix stripped
    expect(first.text).toContain("Kolme village");
  });

  it("keeps the incident correction chain as ordinary messages, in order", () => {
    // The correction + retraction pattern must survive parsing untouched —
    // threading/lifecycle is a later pipeline step.
    expect(messages[1]!.text).toContain("Correction");
    expect(messages[3]!.text).toContain("misreporting");
    expect(messages[1]!.sentAt.getTime()).toBeGreaterThan(messages[0]!.sentAt.getTime());
  });

  it("marks edited messages and strips the marker from the text", () => {
    const edited = messages[1]!;
    expect(edited.isEdited).toBe(true);
    expect(edited.text).not.toContain("<This message was edited>");
    expect(messages[0]!.isEdited).toBe(false);
  });

  it("extracts attached media refs, with and without caption", () => {
    const captioned = messages[4]!;
    expect(captioned.mediaRefs).toEqual(["00000001-report-road-assessment.pdf"]);
    expect(captioned.text).toBe("Road assessment attached");

    const captionless = messages[5]!;
    expect(captionless.mediaRefs).toEqual(["00000002-PHOTO-2026-04-03-11-00-30.jpg"]);
    expect(captionless.text).toBe("");
  });

  it("caption-less omitted media still becomes a message", () => {
    const omitted = messages[6]!;
    expect(omitted.text).toBe("");
    expect(omitted.mediaRefs).toEqual([]);
    expect(omitted.omittedMediaCount).toBe(1);
  });

  it("joins multi-line messages", () => {
    const multiline = messages[8]!;
    expect(multiline.text).toContain("Two things from the morning briefing:");
    expect(multiline.text).toContain("1. The corridor reopens at noon");
    expect(multiline.text).toContain("2. Convoys must register first");
  });

  it("strips invisible directionality characters from text", () => {
    for (const m of messages) {
      expect(m.text).not.toMatch(/[‎‏ ]/);
    }
  });
});

describe("redactPhoneNumbers", () => {
  it("redacts international numbers with separators", () => {
    const redacted = redactPhoneNumbers(
      "Contact the focal point on +249 91 234 5678 for access updates",
    );
    expect(redacted).toBe(
      `Contact the focal point on ${PHONE_REDACTION_PLACEHOLDER} for access updates`,
    );
  });

  it("redacts long local digit runs", () => {
    expect(redactPhoneNumbers("call 0912345678 asap")).toBe(
      `call ${PHONE_REDACTION_PLACEHOLDER} asap`,
    );
  });

  it("leaves dates, times, and small figures alone", () => {
    const text = "On 12.04.26 at 07:21, 3 vehicles and 120 people were reported";
    expect(redactPhoneNumbers(text)).toBe(text);
  });
});

describe("extractUncertaintyMarker", () => {
  it("preserves contributor uncertainty tags", () => {
    expect(extractUncertaintyMarker("Unconfirmed reports of a second strike")).toBe(
      "unconfirmed",
    );
    expect(extractUncertaintyMarker("hearing a rumour of movement")).toBe("rumour");
    expect(extractUncertaintyMarker("confirmed by two sources")).toBeNull();
  });
});

describe("identity + idempotency derivations", () => {
  it("senderRef is pseudonymous, deterministic, and source-scoped", () => {
    const a = deriveSenderRef("src_1", "Basma");
    expect(a).toMatch(/^s_[0-9a-f]{12}$/);
    expect(a).not.toContain("Basma");
    expect(deriveSenderRef("src_1", "Basma")).toBe(a); // stable
    expect(deriveSenderRef("src_2", "Basma")).not.toBe(a); // per-source
  });

  it("externalIds follow the whatsapp:{groupJid}:{messageId} scheme and are stable", () => {
    const messages = parseWhatsAppExport(FIXTURE);
    const withIds = withExternalIds("120363000000000001@g.us", messages);
    for (const m of withIds) {
      expect(m.externalId).toMatch(/^whatsapp:120363000000000001@g\.us:[0-9a-f]{16}$/);
    }
    // Re-parsing the same export derives the same ids in the same order —
    // the property idempotent re-upload rests on.
    const again = withExternalIds("120363000000000001@g.us", parseWhatsAppExport(FIXTURE));
    expect(again.map((m) => m.externalId)).toEqual(withIds.map((m) => m.externalId));
    // And they're unique within the export.
    expect(new Set(withIds.map((m) => m.externalId)).size).toBe(withIds.length);
  });

  it("identical duplicate messages get distinct, stable occurrence ids", () => {
    const dup = [
      `${LRM}[03.04.26, 11:00:30] Chris Sample: ${LRM}image omitted`,
      `${LRM}[03.04.26, 11:00:30] Chris Sample: ${LRM}image omitted`,
    ].join("\r\n");
    const ids = withExternalIds("jid@g.us", parseWhatsAppExport(dup)).map(
      (m) => m.externalId,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    const again = withExternalIds("jid@g.us", parseWhatsAppExport(dup)).map(
      (m) => m.externalId,
    );
    expect(again).toEqual(ids);
  });

  it("occurrence is part of the hash input", () => {
    const messages = parseWhatsAppExport(FIXTURE);
    expect(deriveExternalId("jid", messages[0]!, 0)).not.toBe(
      deriveExternalId("jid", messages[0]!, 1),
    );
  });
});
