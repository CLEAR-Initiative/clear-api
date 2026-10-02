import { describe, it, expect } from "vitest";
import { detectLanguage } from "../../src/utils/language-detect.js";

describe("detectLanguage", () => {
  it("detects Arabic hotline text", () => {
    expect(detectLanguage("قصف على السوق الرئيسي في الفاشر، عدد كبير من الجرحى")).toBe("ar");
  });

  it("keeps Arabic when the message carries Latin acronyms and a redacted phone", () => {
    expect(detectLanguage("وصلت قافلة WFP الى المخيم، اتصلوا على [phone redacted]")).toBe("ar");
  });

  it("detects English, French and Spanish from distinctive stopwords", () => {
    expect(detectLanguage("Flooding near the bridge, people are stuck")).toBe("en");
    expect(detectLanguage("Les routes sont coupées dans le village")).toBe("fr");
    expect(detectLanguage("Hay muchas familias sin agua en el campo")).toBe("es");
  });

  it("returns null for empty, too-short or signal-free text", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("🙏🙏 12345")).toBeNull();
    expect(detectLanguage("[phone redacted] https://example.org/x")).toBeNull();
  });

  it("returns null for Latin text with no stopword evidence or a tie", () => {
    // Somali — Latin script, not a platform language.
    expect(detectLanguage("Biyo ma jiraan tuulada")).toBeNull();
    // One English and one Spanish stopword.
    expect(detectLanguage("the casa y")).toBeNull();
  });

  it("does not read the romanised Arabic article in place names as Spanish", () => {
    expect(detectLanguage("Shelling near al Fashir and el Geneina")).toBe("en");
    expect(detectLanguage("RSF attack el Obeid al Nuhud")).toBeNull();
    expect(detectLanguage("ana fi el souq, al nas mayteen")).toBeNull();
  });

  it("returns null when another script dominates", () => {
    // Tigrinya (Ethiopic script).
    expect(detectLanguage("ማይ የለን ኣብ ዓዲ")).toBeNull();
  });
});
