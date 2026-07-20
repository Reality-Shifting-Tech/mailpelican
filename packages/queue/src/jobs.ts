import { z } from "zod";

/**
 * Job contracts between the outbox dispatcher, BullMQ, and workers. Queue
 * names are stable; payloads are validated at enqueue and dequeue time.
 */

export const QUEUE_NAMES = {
  send: "send",
  webhooks: "webhooks",
} as const;

export const campaignSendJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
});

export type CampaignSendJob = z.infer<typeof campaignSendJobSchema>;

export const messageDispatchJobSchema = z.object({
  workspaceId: z.string().uuid(),
  messageId: z.string().uuid(),
});

export type MessageDispatchJob = z.infer<typeof messageDispatchJobSchema>;

export const webhookNormalizeJobSchema = z.object({
  workspaceId: z.string().uuid(),
  inboxId: z.string().uuid(),
  relayId: z.string().uuid(),
});

export type WebhookNormalizeJob = z.infer<typeof webhookNormalizeJobSchema>;

export const subscriptionConfirmJobSchema = z.object({
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid(),
  listId: z.string().uuid(),
});

export type SubscriptionConfirmJob = z.infer<typeof subscriptionConfirmJobSchema>;

/** Map an outbox topic to the queue it should be enqueued on. */
export function queueForTopic(topic: string): string {
  switch (topic) {
    case "campaign.send":
    case "message.dispatch":
    case "subscription.confirm":
      return QUEUE_NAMES.send;
    case "webhook.normalize":
      return QUEUE_NAMES.webhooks;
    default:
      throw new Error(`No queue registered for outbox topic "${topic}"`);
  }
}
