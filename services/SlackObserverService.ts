/**
 * SlackObserverService
 * Human-readable incident and observability layer for autonomous Rook agents.
 * 
 * DESIGN PRINCIPLES:
 * 1. Observer Only: Observes execution outcomes; never authorizes or triggers transactions.
 * 2. Fail-Safe: Webhook network or formatting failures never throw or affect settlement.
 * 3. Structured Events: Emits standardized Slack Block Kit cards for:
 *    - 🛡️ ROOK HEDGE SETTLED (tx-risky-01)
 *    - ⚠️ ROOK UNDERWRITER DISQUALIFIED (The Graph intelligence vetting)
 *    - 🚨 ROOK SECURITY BLOCK (tx-risky-02 fail-closed)
 */

export interface HedgeSettledPayload {
  txRef: string;
  riskScore: number;
  underwriter: string;
  effectiveRate: number;
  coverageAmount: string;
  settlementStatus: string;
  aquaTxHash?: string;
}

export interface UnderwriterDisqualifiedPayload {
  txRef: string;
  provider: string;
  fillReliabilityScore: string | number;
  requiredMinimum: number;
  reputationTier: string;
  action: string;
}

export interface SecurityBlockPayload {
  txRef: string;
  riskScore: number;
  targetAddress: string;
  action: string;
  executionStatus: string;
  fundsAtRisk: string;
}

export interface SlackNotificationResult {
  sent: boolean;
  status?: number;
  reason?: string;
  payload: Record<string, unknown>;
}

export class SlackObserverService {
  private readonly webhookUrl: string | undefined;

  constructor(webhookUrl: string | undefined = process.env.SLACK_WEBHOOK_URL) {
    this.webhookUrl = webhookUrl;
  }

  /**
   * 1. 🛡️ ROOK HEDGE SETTLED
   */
  public async notifyHedgeSettled(data: HedgeSettledPayload): Promise<SlackNotificationResult> {
    const payload = {
      text: `🛡️ ROOK HEDGE SETTLED: ${data.txRef}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🛡️ ROOK HEDGE SETTLED",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Transaction:*\n\`${data.txRef}\`` },
            { type: "mrkdwn", text: `*Risk Score:*\n${data.riskScore}/100` },
            { type: "mrkdwn", text: `*Underwriter:*\n*${data.underwriter}*` },
            { type: "mrkdwn", text: `*Effective Rate:*\n${data.effectiveRate}:1` },
            { type: "mrkdwn", text: `*Coverage:*\n${data.coverageAmount}` },
            { type: "mrkdwn", text: `*Settlement:*\n\`${data.settlementStatus}\`` },
            { type: "mrkdwn", text: `*Aqua Tx:*\n\`${data.aquaTxHash || "0x-pending-block"}\`` },
          ],
        },
      ],
    };

    return this.postSafe(payload);
  }

  /**
   * 2. ⚠️ ROOK UNDERWRITER DISQUALIFIED
   * Visibly demonstrates that The Graph derived intelligence alters the agent's execution decision.
   */
  public async notifyUnderwriterDisqualified(data: UnderwriterDisqualifiedPayload): Promise<SlackNotificationResult> {
    const payload = {
      text: `⚠️ ROOK UNDERWRITER DISQUALIFIED: ${data.provider}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "⚠️ ROOK UNDERWRITER DISQUALIFIED",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Transaction:*\n\`${data.txRef}\`` },
            { type: "mrkdwn", text: `*Provider:*\n*${data.provider}*` },
            {
              type: "mrkdwn",
              text: `*Reason:*\nfillReliabilityScore = *${data.fillReliabilityScore}%*\nRequired minimum = *${data.requiredMinimum}%* (Tier: ${data.reputationTier})`,
            },
            { type: "mrkdwn", text: `*Action:*\n${data.action}` },
          ],
        },
      ],
    };

    return this.postSafe(payload);
  }

  /**
   * 3. 🚨 ROOK SECURITY BLOCK
   * Flagged exploit address or critical risk (tx-risky-02) demonstrably fail-closed.
   */
  public async notifySecurityBlock(data: SecurityBlockPayload): Promise<SlackNotificationResult> {
    const payload = {
      text: `🚨 ROOK SECURITY BLOCK: ${data.txRef}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🚨 ROOK SECURITY BLOCK",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Transaction:*\n\`${data.txRef}\`` },
            { type: "mrkdwn", text: `*Risk Score:*\n*${data.riskScore}/100 (CRITICAL)*` },
            { type: "mrkdwn", text: `*Target:*\n\`${data.targetAddress}\`` },
            { type: "mrkdwn", text: `*Action:*\n*${data.action}*` },
            { type: "mrkdwn", text: `*Execution:*\n\`${data.executionStatus}\`` },
            { type: "mrkdwn", text: `*Funds at Risk:*\n*${data.fundsAtRisk}*` },
          ],
        },
      ],
    };

    return this.postSafe(payload);
  }

  /**
   * Internal fail-safe poster. Network or Slack errors are caught and never bubble up.
   */
  private async postSafe(payload: Record<string, unknown>): Promise<SlackNotificationResult> {
    if (!this.webhookUrl) {
      return { sent: false, reason: "NO_WEBHOOK_CONFIGURED", payload };
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      return {
        sent: response.ok,
        status: response.status,
        payload,
      };
    } catch (err) {
      // OBSERVABILITY FAILURE MUST NEVER AFFECT SETTLEMENT
      return {
        sent: false,
        reason: (err as Error).message,
        payload,
      };
    }
  }
}
