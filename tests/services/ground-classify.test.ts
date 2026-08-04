/**
 * Classification-enqueue tests: the Celery task name/kwargs contract with
 * clear-pipeline's classify_ground_messages worker, and the fire-and-forget
 * failure swallow (a broker hiccup must never propagate to the ingest).
 * Hermetic: services/celery.js is mocked — no Redis.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendCeleryTaskMock } = vi.hoisted(() => ({
  sendCeleryTaskMock: vi.fn(),
}));

vi.mock("../../src/services/celery.js", () => ({
  sendCeleryTask: sendCeleryTaskMock,
}));

import {
  enqueueGroundClassification,
  GROUND_CLASSIFY_TASK,
} from "../../src/services/ground-classify.js";

describe("enqueueGroundClassification", () => {
  beforeEach(() => {
    sendCeleryTaskMock.mockReset();
    sendCeleryTaskMock.mockResolvedValue("task-id");
  });

  it("enqueues classify_ground_messages with ground_source_id kwargs", () => {
    enqueueGroundClassification("gs_1");

    expect(sendCeleryTaskMock).toHaveBeenCalledExactlyOnceWith(
      GROUND_CLASSIFY_TASK,
      { ground_source_id: "gs_1" },
    );
    expect(GROUND_CLASSIFY_TASK).toBe("src.tasks.ground.classify_ground_messages");
  });

  it("swallows broker failures with a warning (fire-and-forget)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendCeleryTaskMock.mockRejectedValue(new Error("broker down"));

    enqueueGroundClassification("gs_1");
    // Let the rejected promise's catch handler run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("enqueue failed for gs_1"),
      "broker down",
    );
    warnSpy.mockRestore();
  });
});
