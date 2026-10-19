import { describe, expect, it, vi } from "vitest";
import { logger } from "../../src/utils/logger.js";
import { logEventChange } from "../../src/utils/event-log.js";

describe("logEventChange", () => {
  it("logs event id, merged signal ids and count under event.<change>", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    logEventChange("created", { id: "e1", title: "Flood", types: ["flood"], severity: 3 }, ["s1", "s2"]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e1", signalCount: 2, signalIds: ["s1", "s2"], severity: 3 }),
      "event.created",
    );
    info.mockRestore();
  });

  it("caps signalIds but keeps the real count", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const ids = Array.from({ length: 80 }, (_, i) => `s${i}`);
    logEventChange("updated", { id: "e1" }, ids);
    const fields = info.mock.calls[0][0] as { signalIds: string[]; signalCount: number };
    expect(fields.signalIds).toHaveLength(50);
    expect(fields.signalCount).toBe(80);
    info.mockRestore();
  });
});
