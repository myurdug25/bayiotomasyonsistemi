# PowerSA Print Bridge

This small Android bridge lets the B2B web app print thermal receipts without opening the printer vendor app.

Flow:

1. The B2B page calls `powersa-print://receipt?payload=...`.
2. Android opens `com.powersa.printbridge`.
3. The bridge decodes the receipt payload.
4. It writes ESC/POS text to the first paired Bluetooth printer whose name looks like TSC, DSI, printer, POS, MTP, or RPP.

Build:

```powershell
cd tools\print-bridge\android
gradle assembleDebug
```

Install the generated APK on the tablet, pair the TSC/DSI printer in Android Bluetooth settings, then press `Yazdır` in PowerSA.

Notes:

- If no bridge app is installed, the web app falls back to Web Bluetooth and then browser print.
- Android 12+ asks for Bluetooth permission on first use.
- Some TSC models use TSPL instead of ESC/POS. If the first receipt prints unreadable text, the bridge should be switched to TSPL commands for that exact printer model.
