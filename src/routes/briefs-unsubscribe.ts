/**
 * `GET /briefs/unsubscribe?token=` — the link at the foot of every Brief
 * email. Public: the token is the credential. It takes the address off its
 * Recipient list's future sends by setting `unsubscribedAt` and answers with
 * a tiny confirmation page. Following it again keeps the first timestamp.
 *
 * Modelled on the portal's `GET /reset-password`: the URL carries the token,
 * so the response is kept out of caches and out of Referer headers.
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { escapeHtml } from "../services/messaging/templates.js";

/** The slice of the Prisma client the route needs; keeps tests hermetic. */
export type UnsubscribeClient = {
  recipientListMember: {
    findUnique: (args: {
      where: { unsubscribeToken: string };
      select: { id: true; unsubscribedAt: true; list: { select: { name: true } } };
    }) => Promise<{ id: string; unsubscribedAt: Date | null; list: { name: string } } | null>;
    updateMany: (args: {
      where: { id: string; unsubscribedAt: null };
      data: { unsubscribedAt: Date };
    }) => Promise<unknown>;
  };
};

const MAX_TOKEN_LENGTH = 128;

function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} - CLEAR</title>
</head>
<body style="margin: 0; padding: 48px 16px; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <main style="max-width: 440px; margin: 0 auto; padding: 32px; background: #fff; border-radius: 8px; text-align: center;">
    <h1 style="margin: 0 0 12px; font-size: 20px; color: #171717;">${escapeHtml(title)}</h1>
    <p style="margin: 0; font-size: 15px; color: #525252; line-height: 1.5;">${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

export function createBriefsUnsubscribeRouter(
  client: UnsubscribeClient = prisma as unknown as UnsubscribeClient,
): Router {
  const router = Router();

  router.get("/unsubscribe", async (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    const member =
      token && token.length <= MAX_TOKEN_LENGTH
        ? await client.recipientListMember.findUnique({
            where: { unsubscribeToken: token },
            select: { id: true, unsubscribedAt: true, list: { select: { name: true } } },
          })
        : null;
    if (!member) {
      res
        .status(404)
        .send(page("Link not recognised", "This unsubscribe link is invalid or no longer exists."));
      return;
    }
    if (!member.unsubscribedAt) {
      // Conditional, so two clicks racing keep the first time.
      await client.recipientListMember.updateMany({
        where: { id: member.id, unsubscribedAt: null },
        data: { unsubscribedAt: new Date() },
      });
    }
    res
      .status(200)
      .send(
        page(
          "You're unsubscribed",
          `You won't receive Briefs sent to the "${member.list.name}" list any more.`,
        ),
      );
  });

  return router;
}

export const briefsUnsubscribeRouter = createBriefsUnsubscribeRouter();
