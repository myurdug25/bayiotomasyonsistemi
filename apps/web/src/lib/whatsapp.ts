export function normalizeWhatsAppPhone(phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("00")) {
    return digits.slice(2);
  }

  if (digits.length === 10 && digits.startsWith("5")) {
    return `90${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return `90${digits.slice(1)}`;
  }

  return digits;
}

export function buildWhatsAppTextUrl(message: string, phone?: string | null): string {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const encodedMessage = encodeURIComponent(message);

  return normalizedPhone
    ? `https://wa.me/${normalizedPhone}?text=${encodedMessage}`
    : `https://wa.me/?text=${encodedMessage}`;
}
