// The research API's live shapes, captured from quick.aws.com on
// 2026-11-22 (read-only calls; no research was executed for these).
export const researchResponseShape = {
  // GET /quicksight/research/entitlement-units
  entitlements: {
    entitlements: [
      {
        numMinsAvailable: 597,
        numMinsProvisioned: 600,
        overageAllowed: false,
        rateLimitStatus: { isThrottled: false },
        unitType: "RESEARCH_AGENT_HOUR_UNIT",
      },
    ],
    subscriptionMetadata: {
      subscriptionType: "QBUSINESS_FREE_TIER",
      freeTrialMetadata: { status: "ACTIVE", expiryDate: 1797292800 },
    },
  },
  // POST /quicksight/research/get
  get: {
    researchId: "r-9",
    researchStatus: "REPORT_COMPLETE",
    researchTitle: "Spec comparison",
    report: {
      reportText: "The two specs agree on frame order; they differ on retry semantics.",
      citations: [{ title: "RFC 9110", url: "https://www.rfc-editor.org/rfc/rfc9110" }],
    },
  },
}
