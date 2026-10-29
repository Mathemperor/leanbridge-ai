/** Use the real app's registration hint; never a first-party client identity. */
export const PLAN_APP_NAME = "LeanBridge AI";
export const PLAN_REQUEST_IDENTITY = {
  originator: PLAN_APP_NAME,
  "User-Agent": "LeanBridgeAI/0.1.0",
} as const;
