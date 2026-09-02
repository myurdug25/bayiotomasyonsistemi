function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatLocalCalendarDate(value) {
  return [
    value.getFullYear(),
    padDatePart(value.getMonth() + 1),
    padDatePart(value.getDate()),
  ].join("-");
}

export function normalizeLogoDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const sqlDate = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);

    if (sqlDate) {
      return `${sqlDate[1]}-${sqlDate[2]}-${sqlDate[3]}`;
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  // Logo DATE alanı saat dilimi bilgisi taşımaz. UTC'ye çevirmek takvim
  // gününü bir gün geriye kaydırabildiği için yerel tarih parçaları korunur.
  return formatLocalCalendarDate(parsed);
}

export function isLogoCampaignActive(row) {
  // Logo kartının ACTIVE alanı kampanyanın çalışma durumunun tek kaynağıdır.
  // Tarihler bilgi amaçlı taşınır; Logo'da aktif bırakılan kart B2B tarafından
  // ayrıca takvim filtresiyle kapatılmaz.
  return Number(row?.ACTIVE ?? row?.active ?? 0) === 0;
}
