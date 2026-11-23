import { redteamHtml } from "../../common/reports/standalone.js";
import type { RedTeamReport } from "./models.js";

export function exportRedteamHtml(report: RedTeamReport): Promise<string> {
  return redteamHtml(report);
}
