const PRINT_FRAME_ATTRIBUTE = "data-powersa-print-frame";

export function printPageInPlace(url: string): void {
  if (typeof window === "undefined") {
    return;
  }

  document.querySelectorAll<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTRIBUTE}]`).forEach((frame) => {
    frame.remove();
  });

  const frame = document.createElement("iframe");
  frame.setAttribute(PRINT_FRAME_ATTRIBUTE, "true");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.src = url;

  document.body.appendChild(frame);

  window.setTimeout(() => {
    frame.remove();
  }, 10 * 60 * 1000);
}
