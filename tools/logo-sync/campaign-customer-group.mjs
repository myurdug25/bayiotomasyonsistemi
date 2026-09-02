function normalized(value) {
  if (value === null || value === undefined) return null;

  const result = String(value).trim();

  return result === "" ? null : result;
}

function fGroup(value) {
  const match = normalized(value)?.match(/(?:^|[^A-Z0-9])(F(?:[1-9]|1[0-2]))(?:[^A-Z0-9]|$)/i);

  return match?.[1]?.toUpperCase() ?? null;
}

/**
 * Resolve the campaign's customer group without letting Logo's numeric CLTYPE
 * mask a concrete F1-F12 price/customer group stored in another column.
 */
export function resolveCampaignCustomerGroup(row, code = null, name = null) {
  const candidates = [
    ["clspecode", row.CLSPECODE],
    ["tradinggrp", row.TRADINGGRP],
    ["specode", row.SPECODE],
    ["cargroupcode", row.CARGROUPCODE],
    ["cardgrpcode", row.CARDGRPCODE],
    ["custgroup", row.CUSTGROUP],
    ["clcard_type", row.CLCARD_TYPE],
    ["cltype", row.CLTYPE],
  ];

  for (const [source, value] of candidates) {
    const group = fGroup(value);
    if (group) return { group, source };
  }

  const inferred = fGroup(`${normalized(code) ?? ""} ${normalized(name) ?? ""}`);
  if (inferred) return { group: inferred, source: "campaign_code" };

  for (const [source, value] of candidates) {
    const group = normalized(value);
    if (group) return { group: group.toUpperCase(), source };
  }

  return { group: null, source: null };
}
