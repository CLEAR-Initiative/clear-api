interface ButtondownResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: unknown[];
}

export interface NewsletterSubscriberResult {
  configured: boolean;
  count: number | null;
  error?: string;
}

/**
 * Fetch the total subscriber count from Buttondown.
 * Returns `configured: false` when no API key is set so the admin
 * dashboard can render a "not configured" state without throwing.
 */
export async function fetchNewsletterSubscriberCount(
  apiKey: string | undefined,
): Promise<NewsletterSubscriberResult> {
  if (!apiKey) {
    return { configured: false, count: null };
  }

  try {
    const res = await fetch("https://api.buttondown.com/v1/subscribers?page=1", {
      headers: { Authorization: `Token ${apiKey}` },
    });

    if (!res.ok) {
      return {
        configured: true,
        count: null,
        error: "Buttondown API unavailable",
      };
    }

    const data = (await res.json()) as ButtondownResponse;
    return { configured: true, count: data.count };
  } catch {
    return {
      configured: true,
      count: null,
      error: "Failed to fetch subscriber count",
    };
  }
}
