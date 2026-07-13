/**
 * Thin Dagster GraphQL client — just enough to launch a
 * `process_manual_document_job` run and poll its status.
 *
 * All calls go against the Dagster webserver's `/graphql` endpoint.
 * When `DAGSTER_URL` isn't set (dev-only Dagster-offline case), each
 * function returns an "unknown" / null result rather than throwing —
 * so the upload path can still stage a PDF in S3 while the operator
 * spins Dagster back up.
 *
 * No SDK dependency — Dagster's GraphQL is a small enough surface that
 * hand-written queries via `fetch` are cleaner than pulling in a full
 * client. Two operations:
 *   - launchRun(jobName, runConfigJson, tags) → runId
 *   - runOrError(runId) → { status, startTime, endTime, tags }
 */

import { env } from "./env.js";

/** Statuses returned by Dagster's `RunStatus` enum, mapped 1:1. We
 *  fold Dagster's transient states (STARTING, MANAGED, CANCELING, …)
 *  into the four terminal-ish buckets a UI cares about, plus UNKNOWN
 *  for missing runs or offline Dagster. */
export type IngestStatus = "QUEUED" | "STARTED" | "SUCCESS" | "FAILURE" | "CANCELED" | "UNKNOWN";

export interface LaunchRunResult {
  runId: string;
}

export interface RunStatus {
  runId: string;
  status: IngestStatus;
  startTime: Date | null;
  endTime: Date | null;
  tags: Record<string, string>;
}

/**
 * Launch a Dagster run for a named job with the given runConfig JSON.
 *
 * @param jobName        e.g. "process_manual_document_job"
 * @param runConfigJson  object matching the job's RunConfig shape;
 *                       will be JSON.stringify'd — Dagster's
 *                       `runConfigData` scalar accepts both YAML and
 *                       JSON strings.
 * @param tags           key/value pairs stored on the run. Used here
 *                       to persist report_id / s3_key / title so the
 *                       poll endpoint can echo them back to the client.
 */
export async function launchRun(
  jobName: string,
  runConfigJson: object,
  tags: Record<string, string>,
): Promise<LaunchRunResult> {
  if (!env.DAGSTER_URL) {
    throw new Error(
      "DAGSTER_URL not set — cannot launch Dagster run. Set the Dagster " +
        "webserver URL in .env or leave it unset to stage uploads without " +
        "kicking off the ingest pipeline.",
    );
  }

  const mutation = `
    mutation LaunchRun($executionParams: ExecutionParams!) {
      launchRun(executionParams: $executionParams) {
        __typename
        ... on LaunchRunSuccess {
          run { runId }
        }
        ... on RunConfigValidationInvalid {
          errors { message }
        }
        ... on PipelineNotFoundError { message }
        ... on InvalidSubsetError { message }
        ... on PythonError { message }
      }
    }
  `;

  const variables = {
    executionParams: {
      selector: {
        repositoryLocationName: env.DAGSTER_REPOSITORY_LOCATION_NAME,
        repositoryName: env.DAGSTER_REPOSITORY_NAME,
        jobName,
      },
      runConfigData: JSON.stringify(runConfigJson),
      executionMetadata: {
        tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      },
    },
  };

  // Loose response shape — Dagster returns a union whose branches
  // don't share fields cleanly. We discriminate on `__typename` at
  // runtime with the fields we care about typed as optional, so TS
  // sees every field on every branch.
  interface LaunchRunResponse {
    launchRun: {
      __typename: string;
      run?: { runId: string };
      errors?: Array<{ message: string }>;
      message?: string;
    };
  }
  const data = await dagsterFetch<LaunchRunResponse>(mutation, variables);

  const result = data.launchRun;
  if (result.__typename === "LaunchRunSuccess" && result.run) {
    return { runId: result.run.runId };
  }
  if (result.__typename === "RunConfigValidationInvalid") {
    const messages = (result.errors ?? []).map((e) => e.message).join("; ");
    throw new Error(`Dagster rejected run config: ${messages}`);
  }
  throw new Error(
    `Dagster launchRun failed (${result.__typename}): ${result.message ?? "no detail"}`,
  );
}

/**
 * Fetch a run's current status. Returns null when the runId doesn't
 * exist on this Dagster instance (typically means the run was launched
 * against a different DAGSTER_URL — surface the miss cleanly rather
 * than pretending it's UNKNOWN). Returns a `status: "UNKNOWN"` record
 * when Dagster is offline (no DAGSTER_URL).
 */
export async function getRunStatus(runId: string): Promise<RunStatus | null> {
  if (!env.DAGSTER_URL) {
    return { runId, status: "UNKNOWN", startTime: null, endTime: null, tags: {} };
  }

  const query = `
    query GetRun($runId: ID!) {
      runOrError(runId: $runId) {
        __typename
        ... on Run {
          runId
          status
          startTime
          endTime
          tags { key value }
        }
        ... on RunNotFoundError { message }
        ... on PythonError { message }
      }
    }
  `;

  interface RunOrErrorResponse {
    runOrError: {
      __typename: string;
      runId?: string;
      status?: string;
      startTime?: number | null;
      endTime?: number | null;
      tags?: Array<{ key: string; value: string }>;
      message?: string;
    };
  }
  const data = await dagsterFetch<RunOrErrorResponse>(query, { runId });

  const run = data.runOrError;
  if (run.__typename === "RunNotFoundError") return null;
  if (run.__typename === "PythonError") {
    throw new Error(`Dagster runOrError failed: ${run.message ?? "no detail"}`);
  }
  return {
    runId: run.runId ?? runId,
    status: normaliseStatus(run.status ?? ""),
    // Dagster returns Unix epoch seconds as floats; convert to Date.
    startTime: run.startTime != null ? new Date(run.startTime * 1000) : null,
    endTime: run.endTime != null ? new Date(run.endTime * 1000) : null,
    tags: Object.fromEntries((run.tags ?? []).map((t) => [t.key, t.value])),
  };
}

/**
 * Fold Dagster's full RunStatus enum (STARTING/MANAGED/CANCELING/…)
 * down to the coarse states the UI needs. Anything we don't recognise
 * flows through as UNKNOWN — safer than crashing the resolver when
 * Dagster introduces a new status.
 */
function normaliseStatus(raw: string): IngestStatus {
  switch (raw) {
    case "QUEUED":
    case "NOT_STARTED":
      return "QUEUED";
    case "STARTING":
    case "STARTED":
    case "MANAGED":
      return "STARTED";
    case "SUCCESS":
      return "SUCCESS";
    case "FAILURE":
      return "FAILURE";
    case "CANCELING":
    case "CANCELED":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

async function dagsterFetch<TData>(query: string, variables: unknown): Promise<TData> {
  const url = `${env.DAGSTER_URL!.replace(/\/+$/, "")}/graphql`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Dagster HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }
  const payload = (await resp.json()) as { data?: TData; errors?: Array<{ message: string }> };
  if (payload.errors) {
    throw new Error(`Dagster GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  if (!payload.data) {
    throw new Error("Dagster response missing data");
  }
  return payload.data;
}
