package com.powersa.printbridge

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

class MainActivity : Activity() {
    private val sppUuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val printerCharset: Charset = Charset.forName("CP857")
    private val protocolEscPos = "escpos"
    private val protocolTspl = "tspl"
    private val protocolCpcl = "cpcl"
    private val gucsaLogoBitmap: ByteArray by lazy {
        Base64.decode(
            """
            AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf+/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/8f+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/4P/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/4P/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/wH/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/wH/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/gD/wAAAAAAAAA/////gH/8AAAAAAAAAAAAA////+AAAP/4AAAAAAAAAAAAAAAAP/gB/4AAAAAAAA//////wH/8AH/+AD/////4H/////AAAf/4AAAAAAAAAAAAAAAAP/AB/4AAAAAAAB//////wH/8AH/+AH/////wP/////AAAf/8AAAAAAAAAAAAAAAAf+AA/8AAAAAAAD//////wH/8AH/+AP/////wf/////AAAf/8AAAAAAAAAAAAAAAAf+AA/8AAAAAAAD//////wH/8AH/+Af/////gf////+AAA//8AAAAAAAAAAAAAAAA/8AAf+AAAAAAAD//////wH/8AH/+A//////gf////+AAA//+AAAAAAAAAAAAAAAA/8AAf+AAAAAAAD//////wH/8AH/+A//////Af////+AAA//+AAAAAAAAAAAAAAAB/4AAP/AAAAAAAD//////gH/wAH/+A//////Af////+AAB//+AAAAAAAAAAAAAAAD/4AAH/gAAAAAAH//////gH/gAH/+B/////+Af////+AAB///AAAAAAAAAAAAAAAD/wAAH/gAAAAAAH//////gH+AAH/+B/////+Af////+AAB///AAAAAAAAAAAAAAAH/gAAD/wAAAAAAH//////AH8MAH/+B/////+Af/8AAAAAD///AAAAAAAAAAAAAAAH/gAAB/wAAAAAAH/+AAAAAHw8AH/+B/////8Af/wAAAAAD///AAAAAAAAAAAAAAAP/AAAB/4AAAAAAH/+AAAAAHh8AH/+B/////8Af/wAAAAAD///gAAAAAAAAAAAAAAP/ABgA/4AAAAAAH/+AAAAAHH8AH/+B//gAAAAf/wAAAAAH///gAAAAAAAAAAAAAAf+ADgA/8AAAAAAH/+AAAAAEP8AH/+B//gAAAAf/wAAAAAH///gAAAAAAAAAAAAAA/8ADwAf+AAAAAAH/+AAAAAAf8AH/+B//gAAAAf/wAAAAAH///gAAAAAAAAAAAAAA/8AHwAf+AAAAAAH/+AAAAAB/8AH/+B//gAAAAf/+AAAAAP///wAAAAAAAAAAAAAB/4APgAP/AAAAAAH/+AAAAAD/8AH/+B//gAAAAf//+AAAAP///wAAAAAAAAAAAAAB/4APgAH/AAAAAAH/+AAAAAH/8AH/+B//gAAAAf///4AAAP///wAAAAAAAAAAAAAD/wAfAAH/gAAAAAH/+AAAAAH/8AH/+B//gAAAAf////gAAf///4AAAAAAAAAAAAAD/wAeAAD/gAAAAAH/+AH//wH/8AH/+B//gAAAAf////4AAf///4AAAAAAAAAAAAAH/gA+AAD/wAAAAAH/+AP//wH/8AH/+B//gAAAAf////+AAf/v/4AAAAAAAAAAAAAP/AA8AAB/4AAAAAH/+AP//4H/8AH/+B//gAAAAf////+AA//v/8AAAAAAAAAAAAAP/AB/////4AAAAAH/+Af//4H/8AH/+B//gAAAAf////+AA//n/8AAAAAAAAAAAAAf+AD/////8AAAAAH/+Af//4H/8AH/+B//gAAAAP/////AA//n/8AAAAAAAAAAAAAf+AD/////8AAAAAH/+Af//4H/8AH/+B//gAAAAH/////AB//H/+AAAAAAAAAAAAA/8AH/////+AAAAAH/+Af//4H/8AH/+B//gAAAAB/////AB//H/+AAAAAAAAAAAAA/8AHgAAAP+AAAAAH/+Af//4H/8AH/+B//gAAAAAH////AB//H/+AAAAAAAAAAAAB/4APgAAAP/AAAAAH/+Af//4H/8AH/+B//gAAAAAAf///AD////+AAAAAAAAAAAAD/wAfAAAAH/gAAAAH/+Af//4H/8AH/+B//gAAAAAAAf//AD/////AAAAAAAAAAAAD/wAfAAAAH/gAAAAH/+A///4H/8AH/+B//gAAAAAAAD//AD/////AAAAAAAAAAAAH/gA+AAAAD/wAAAAH/+Af//4H/8AH/+B//gAAAAAAAB//AH/////AAAAAAAAAAAAH/gA8AAAAB/wAAAAH/+AAf/4H/8AH/+B//gAAAAAAAB//AH/////gAAAAAAAAAAAP/AB8AAAAB/4AAAAH/+AAf/4H/8AH/+B//gAAAAAAAB//AH/////gAAAAAAAAAAAP/AB4AAAAA/4AAAAH/+AAf/4H/8AH/+B//gAAAAAAAB//AH/////gAAAAAAAAAAAf+AD4AAAAA/8AAAAD/+AAf/4H/8AH/+B/////+AAAAB//AP/////gAAAAAAAAAAA/8AHwAAAAAf8AAAAD/+AAf/4H/+AP/+B/////+AAAAH//AP/////wAAAAAAAAAAA/8AHgAAAAAP+AAAAD//AB//4H/////+B/////+AP/////Af/////wAAAAAAAAAAB/4APgAAAAAP/AAAAD//////4H/////+B/////+AP/////Af/4A//wAAAAAAAAAAB/4AP///+IAH/AAAAD//////4H/////+B/////8AP/////Af/4Af/4AAAAAAAAAAD/wAf////8AH/gAAAD//////wH/////+A/////8AP/////Af/4Af/4AAAAAAAAAAD/wAf////+AD/gAAAD//////wH/////+A/////8AP/////A//wAf/4AAAAAAAAAAH/gAf////8AD/wAAAD//////wH/////8A/////8AP/////A//wAf/8AAAAAAAAAAP/AAAAAAAAAB/wAAAD//////wH/////8Af////4Af////+A//wAP/8AAAAAAAAAAP/AAAAAAAAAB/4AAAD//////gD/////4AP////4Af////+B//gAP/8AAAAAAAAAAf+AAAAAAAAAA/8AAAB//////AB/////wAH////4Af////8B//gAP/8AAAAAAAAAAf+AAAAAAAAAAf8AAAAf////+AAf////gAB////wAP////gB//gAH/8AAAAAAAAAA/8AAAAAAAAAAf+AAAAD////gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/8AAAAAAAAAAP+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/4AAAAAAAAAAP/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAABAAAAAAAAAAB/wAAAAAAAAAAH/AAAAAAAAAAAAAAAAAAAAAf/n1sAABgAB+AAAA4HgAAAAAAAAAD/wAAAAAAAAAAH/gAAAAAAAAAAAAAAAAAAAAf/31sAABgAD+AAAA4HwAAAAAAAAAH/gAAAAAAAAAAD/wAAAAAAAAAAAAAAAAAAAAf/2F/zx5vcDCfF+A4GAAAAAAAAAAH/gAAAAAAAAAAD/wAAAAAAAAAAAAAAAAAAAAf/2H/379v+GAfH/BsHAAAAAAAAAAP//////////////4AAAAAAAAAAAAAAAAAAAAf/n1tubNt2GfbHjBsHgAAAAAAAAAP//////////////4AAAAAAAAAAAAAAAAAAAAf/H1tv+BtmGf7HhB8BwAAAAAAAAAf//////////////8AAAAAAAAAAAAAAAAAAAAf+GFtv+BomGfbPhD+AwAAAAAAAAA///////////////8AAAAAAAAAAAAAAAAAAAAf4GFtubNomDDbPjDGEwAAAAAAAAA///////////////+AAAAAAAAAAAAAAAAAAAAfwGFtn79omD+Z//DH32AAAAAAAAB///////////////+AAAAAAAAAAAAAAAAAAAAfAGFtjx5oiB8Z9+GD3mAAAAAAAAB////////////////AAAAAAAAAAAAAAAAAAAAeAAAAAAAAAAAABgAABgAAAAAAAAD////////////////AAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAABgAABgAAAAAAAAB////////////////AAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAADgAAA
            """.trimIndent(),
            Base64.DEFAULT
        )
    }
    private val prefs: SharedPreferences by lazy { getSharedPreferences("bos_print_bridge", MODE_PRIVATE) }
    private var pendingPayload: String? = null
    private var selectedAddress: String? = null
    private lateinit var root: LinearLayout
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingPayload = intent?.data?.getQueryParameter("payload")

        if (!hasBluetoothPermission()) {
            requestBluetoothPermission()
            return
        }

        if (!pendingPayload.isNullOrBlank()) {
            printPayloadOrShowSetup(pendingPayload!!)
            return
        }

        renderSetup("Yazıcıyı bir kez seçin. Sonraki baskılarda bu ekran açılmadan yazdırılır.")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pendingPayload = intent.data?.getQueryParameter("payload")
        if (!hasBluetoothPermission()) {
            requestBluetoothPermission()
            return
        }
        pendingPayload?.let { printPayloadOrShowSetup(it) } ?: renderSetup("Yazıcı ayarlarını kontrol edin.")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 42) {
            return
        }

        if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
            pendingPayload?.let { printPayloadOrShowSetup(it) } ?: renderSetup("Bluetooth izni verildi. Yazıcıyı seçin.")
            return
        }

        renderSetup("Bluetooth izni verilmedi. Yazdırmak için izin gerekiyor.")
    }

    private fun requestBluetoothPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN,
                ),
                42
            )
            return
        }

        renderSetup("Bluetooth izni eksik. Android ayarlarından izin verin.")
    }

    private fun hasBluetoothPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            (
                checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
                    checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                )
    }

    private fun printPayloadOrShowSetup(payload: String) {
        val savedAddress = prefs.getString("printer_address", null)
        val printer = findBondedDevice(savedAddress)

        if (printer == null) {
            renderSetup("Kayıtlı TSC yazıcı bulunamadı. Yazıcıyı seçip test etiketi basın.")
            return
        }

        renderPrinting("Yazdırılıyor: ${printer.safeName()}")

        Thread {
            try {
                val plainText = decodePayload(payload)
                val protocol = prefs.getString("printer_protocol", protocolEscPos) ?: protocolEscPos
                printToDevice(printer, buildReceiptForProtocol(plainText, protocol))
                runOnUiThread {
                    toast("Baskı gönderildi: ${printer.safeName()}")
                    finish()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    renderSetup("Baskı başarısız: ${error.message ?: "Yazıcıya bağlanılamadı."}")
                }
            }
        }.start()
    }

    private fun renderSetup(message: String) {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 28, 28, 28)
            setBackgroundColor(Color.rgb(6, 24, 17))
        }

        val title = TextView(this).apply {
            text = "BOS Print Bridge"
            setTextColor(Color.WHITE)
            textSize = 24f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }

        statusText = TextView(this).apply {
            text = message
            setTextColor(Color.rgb(228, 238, 232))
            textSize = 15f
            setPadding(0, 12, 0, 18)
        }

        val devices = bondedDevices()
        selectedAddress = prefs.getString("printer_address", null)
            ?: devices.firstOrNull { it.isLikelyPrinter() }?.address
            ?: devices.firstOrNull()?.address

        val group = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }

        if (devices.isEmpty()) {
            group.addView(infoText("Eşleşmiş Bluetooth yazıcı yok. Önce Android Bluetooth ayarından TSC/DSI yazıcıyı eşleştirin."))
        } else {
            devices.forEach { device ->
                val radio = RadioButton(this).apply {
                    text = "${device.safeName()}  ${device.address}"
                    setTextColor(Color.WHITE)
                    textSize = 15f
                    id = View.generateViewId()
                    tag = device.address
                    isChecked = device.address == selectedAddress
                    setPadding(0, 10, 0, 10)
                }
                group.addView(radio)
            }
            group.setOnCheckedChangeListener { viewGroup, checkedId ->
                selectedAddress = viewGroup.findViewById<RadioButton>(checkedId)?.tag as? String
            }
        }

        val escPosTestButton = actionButton("Test ESC/POS") {
            val printer = findBondedDevice(selectedAddress)
            if (printer == null) {
                statusText.text = "Önce yazıcı seçin."
                return@actionButton
            }

            testPrinterProtocol(printer, protocolEscPos)
        }

        val tsplTestButton = actionButton("Test TSPL") {
            val printer = findBondedDevice(selectedAddress)
            if (printer == null) {
                statusText.text = "Önce yazıcı seçin."
                return@actionButton
            }

            testPrinterProtocol(printer, protocolTspl)
        }

        val cpclTestButton = actionButton("Test CPCL") {
            val printer = findBondedDevice(selectedAddress)
            if (printer == null) {
                statusText.text = "Önce yazıcı seçin."
                return@actionButton
            }

            testPrinterProtocol(printer, protocolCpcl)
        }

        val clearButton = actionButton("Yazıcı Kaydını Temizle") {
            prefs.edit()
                .remove("printer_address")
                .remove("printer_name")
                .remove("printer_protocol")
                .apply()
            selectedAddress = null
            renderSetup("Kayıt temizlendi. Yazıcıyı tekrar seçip test edin.")
        }

        val saveButton = actionButton("Yazıcıyı Kaydet") {
            val printer = findBondedDevice(selectedAddress)
            if (printer == null) {
                statusText.text = "Kaydedilecek yazıcı seçilmedi."
                return@actionButton
            }

            prefs.edit()
                .putString("printer_address", printer.address)
                .putString("printer_name", printer.safeName())
                .apply()
            statusText.text = "Kaydedildi: ${printer.safeName()}. BOS sitesinden Yazdır diyebilirsiniz."
        }

        val bluetoothButton = actionButton("Bluetooth Ayarlarını Aç") {
            startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
        }

        val closeButton = actionButton("Kapat") {
            finish()
        }

        root.addView(title)
        root.addView(statusText)
        root.addView(group)
        root.addView(escPosTestButton)
        root.addView(tsplTestButton)
        root.addView(cpclTestButton)
        root.addView(saveButton)
        root.addView(clearButton)
        root.addView(bluetoothButton)
        root.addView(closeButton)

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun testPrinterProtocol(printer: BluetoothDevice, protocol: String) {
        statusText.text = "Test yazdırılıyor: ${printer.safeName()} ${printer.address} (${protocol.uppercase(Locale.ROOT)})"
        Thread {
            try {
                printToDevice(printer, buildTestForProtocol(protocol))
                prefs.edit()
                    .putString("printer_address", printer.address)
                    .putString("printer_name", printer.safeName())
                    .putString("printer_protocol", protocol)
                    .putLong("last_success_at", System.currentTimeMillis())
                    .apply()
                runOnUiThread {
                    statusText.text = "${protocol.uppercase(Locale.ROOT)} modu kaydedildi. Kağıt çıktıysa BOS sitesinden Yazdır diyebilirsiniz. Çıkmadıysa diğer testleri deneyin."
                    toast("Test gönderildi: ${protocol.uppercase(Locale.ROOT)}")
                }
            } catch (error: Exception) {
                runOnUiThread {
                    statusText.text = "Test başarısız (${protocol.uppercase(Locale.ROOT)}): ${error.message ?: "Bağlantı kurulamadı."}"
                }
            }
        }.start()
    }

    private fun renderPrinting(message: String) {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(28, 28, 28, 28)
            setBackgroundColor(Color.rgb(6, 24, 17))
        }
        layout.addView(TextView(this).apply {
            text = message
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        setContentView(layout)
    }

    private fun actionButton(label: String, action: () -> Unit): Button {
        return Button(this).apply {
            text = label
            textSize = 15f
            setTextColor(Color.rgb(9, 26, 18))
            setBackgroundColor(Color.rgb(255, 214, 34))
            setPadding(10, 8, 10, 8)
            setOnClickListener { action() }
        }
    }

    private fun infoText(message: String): TextView {
        return TextView(this).apply {
            text = message
            setTextColor(Color.WHITE)
            textSize = 15f
            setPadding(0, 12, 0, 12)
        }
    }

    private fun decodePayload(payload: String): String {
        val normalized = payload.replace('-', '+').replace('_', '/')
        val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
        val jsonText = String(Base64.decode(padded, Base64.DEFAULT), Charsets.UTF_8)
        val json = JSONObject(jsonText)
        return json.optString("plain_text")
    }

    private fun bondedDevices(): List<BluetoothDevice> {
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: return emptyList()
        return adapter.bondedDevices
            ?.toList()
            ?.sortedWith(compareByDescending<BluetoothDevice> { it.isLikelyPrinter() }.thenBy { it.safeName() })
            ?: emptyList()
    }

    private fun findBondedDevice(address: String?): BluetoothDevice? {
        if (address.isNullOrBlank()) {
            return null
        }

        return bondedDevices().firstOrNull { it.address == address }
    }

    private fun printToDevice(device: BluetoothDevice, commands: ByteArray) {
        val adapter = BluetoothAdapter.getDefaultAdapter()
        if (adapter?.isDiscovering == true) {
            adapter.cancelDiscovery()
        }

        val firstError = runCatching {
            val socket = device.createInsecureRfcommSocketToServiceRecord(sppUuid)
            writeBluetoothSocket(socket, commands)
        }.exceptionOrNull()

        if (firstError == null) {
            return
        }

        runCatching {
            val socket = device.createRfcommSocketToServiceRecord(sppUuid)
            writeBluetoothSocket(socket, commands)
        }.getOrElse { secondError ->
            throw secondError.also {
                it.addSuppressed(firstError)
            }
        }
    }

    private fun writeBluetoothSocket(socket: BluetoothSocket, commands: ByteArray) {
        socket.use {
            it.connect()
            val output = it.outputStream
            commands.toList()
                .chunked(256)
                .forEach { chunk ->
                    output.write(chunk.toByteArray())
                    output.flush()
                    Thread.sleep(25)
                }
            output.flush()
            Thread.sleep(900)
        }
    }

    private fun buildPlainEscPosTest(): ByteArray {
        val now = SimpleDateFormat("dd.MM.yyyy HH:mm", Locale("tr", "TR")).format(Date())
        return escPosDocument(includeLogo = false) {
            feed(1)
            line("BOS PRINT BRIDGE", align = 1, bold = true, doubleWidth = true, doubleHeight = true)
            line("TEST BASKISI", align = 1, bold = true, doubleWidth = true, doubleHeight = false)
            line(now, align = 1, bold = false)
            separator()
            line("YAZICI HAZIR", align = 1, bold = true, doubleWidth = true, doubleHeight = true)
            feed(3)
            cut()
        }
    }

    private fun buildTestForProtocol(protocol: String): ByteArray {
        return when (protocol) {
            protocolTspl -> buildTsplTest()
            protocolCpcl -> buildCpclTest()
            else -> buildPlainEscPosTest()
        }
    }

    private fun buildReceiptForProtocol(plainText: String, protocol: String): ByteArray {
        return when (protocol) {
            protocolTspl -> buildTsplReceipt(plainText)
            protocolCpcl -> buildCpclReceipt(plainText)
            else -> buildEscPosReceipt(plainText)
        }
    }

    private fun buildTsplTest(): ByteArray {
        val now = SimpleDateFormat("dd.MM.yyyy HH:mm", Locale("tr", "TR")).format(Date())
        return """
            SIZE 58 mm,38 mm
            GAP 0 mm,0
            DENSITY 12
            SPEED 3
            DIRECTION 1
            REFERENCE 0,0
            CLS
            TEXT 16,16,"3",0,2,2,"TSPL TEST"
            TEXT 16,92,"3",0,1,1,"BOS PRINT BRIDGE"
            TEXT 16,132,"3",0,1,1,"$now"
            TEXT 16,190,"3",0,2,2,"YAZICI HAZIR"
            PRINT 1,1

        """.trimIndent().replace("\n", "\r\n").toByteArray(printerCharset)
    }

    private fun buildCpclTest(): ByteArray {
        val now = SimpleDateFormat("dd.MM.yyyy HH:mm", Locale("tr", "TR")).format(Date())
        return """
            ! 0 200 200 420 1
            CENTER
            TEXT 4 2 0 20 CPCL TEST
            TEXT 4 0 0 78 BOS PRINT BRIDGE
            TEXT 4 0 0 124 $now
            TEXT 4 2 0 208 YAZICI HAZIR
            FORM
            PRINT

        """.trimIndent().replace("\n", "\r\n").toByteArray(printerCharset)
    }

    private fun buildTsplReceipt(plainText: String): ByteArray {
        val receipt = parseCollectionReceipt(plainText)
        var y = 16
        val commands = mutableListOf<String>()
        commands.add("TEXT 92,$y,\"3\",0,2,2,\"GUCSA\"")
        y += 58
        commands.add("TEXT 28,$y,\"3\",0,1,1,\"Filitrecim Grup A.S.\"")
        y += 48
        receipt.valueLines().forEach { value ->
            wrapLine(value, 27).forEach { line ->
                commands.add("TEXT 16,$y,\"3\",0,1,1,\"${line.escapePrinterText()}\"")
                y += 36
            }
        }
        y += 8
        commands.add("TEXT 16,$y,\"3\",0,1,1,\"----------------------------\"")
        y += 36
        commands.add("TEXT 88,$y,\"3\",0,2,1,\"TAHSILAT\"")
        y += 48
        receipt.paymentLines().forEach { line ->
            commands.add("TEXT 16,$y,\"3\",0,1,1,\"${line.escapePrinterText()}\"")
            y += 36
        }
        commands.add("TEXT 16,$y,\"3\",0,1,1,\"${receipt.totalLine().escapePrinterText()}\"")
        y += 38
        commands.add("TEXT 16,$y,\"3\",0,1,2,\"${receipt.remainingLine().escapePrinterText()}\"")
        y += 48
        commands.add("TEXT 16,$y,\"3\",0,1,1,\"----------------------------\"")
        y += 38
        receipt.signatureLines().forEach { line ->
            commands.add("TEXT 16,$y,\"3\",0,1,1,\"${line.escapePrinterText()}\"")
            y += 36
        }
        y += 12
        val heightMm = maxOf(45, ((y + 16) / 8).coerceAtMost(220))

        return """
            SIZE 58 mm,$heightMm mm
            GAP 0 mm,0
            DENSITY 12
            SPEED 3
            DIRECTION 1
            REFERENCE 0,0
            CLS
            ${commands.joinToString("\r\n")}
            PRINT 1,1

        """.trimIndent().replace("\n", "\r\n").toByteArray(printerCharset)
    }

    private fun buildCpclReceipt(plainText: String): ByteArray {
        val receipt = parseCollectionReceipt(plainText)
        var y = 20
        val commands = mutableListOf<String>()
        commands.add("CENTER")
        commands.add("TEXT 4 2 0 $y GUCSA")
        y += 58
        commands.add("TEXT 4 0 0 $y Filitrecim Grup A.S.")
        y += 48
        commands.add("LEFT")
        receipt.valueLines().forEach { value ->
            wrapLine(value, 27).forEach { line ->
                commands.add("TEXT 4 0 16 $y ${line.escapePrinterText()}")
                y += 36
            }
        }
        y += 8
        commands.add("TEXT 4 0 16 $y ----------------------------")
        y += 36
        commands.add("CENTER")
        commands.add("TEXT 4 1 0 $y T A H S I L A T")
        y += 48
        commands.add("LEFT")
        receipt.paymentLines().forEach { line ->
            commands.add("TEXT 4 0 16 $y ${line.escapePrinterText()}")
            y += 36
        }
        commands.add("TEXT 4 0 16 $y ${receipt.totalLine().escapePrinterText()}")
        y += 38
        commands.add("TEXT 4 1 16 $y ${receipt.remainingLine().escapePrinterText()}")
        y += 48
        commands.add("TEXT 4 0 16 $y ----------------------------")
        y += 38
        receipt.signatureLines().forEach { line ->
            commands.add("TEXT 4 0 16 $y ${line.escapePrinterText()}")
            y += 36
        }
        y += 12
        val height = maxOf(420, y + 24)

        return """
            ! 0 200 200 $height 1
            LEFT
            ${commands.joinToString("\r\n")}
            FORM
            PRINT

        """.trimIndent().replace("\n", "\r\n").toByteArray(printerCharset)
    }

    private fun buildEscPosReceipt(plainText: String): ByteArray {
        val receipt = parseCollectionReceipt(plainText)
        return escPosDocument(includeLogo = true) {
            feed(1)
            receipt.valueLines().forEach { value ->
                wrapLine(value, 32).forEach { wrapped ->
                    line(wrapped, bold = true)
                }
            }
            separator()
            line("TAHSILAT", align = 1, bold = true, doubleWidth = true, doubleHeight = false)
            receipt.paymentLines().forEach { payment ->
                line(payment, bold = true)
            }
            line(receipt.totalLine(), bold = true)
            line(receipt.remainingLine(), bold = true, doubleWidth = false, doubleHeight = true)
            separator()
            receipt.signatureLines().forEach { value ->
                line(value, bold = true)
            }
            feed(1)
            cut()
        }
    }

    private fun parseCollectionReceipt(plainText: String): CollectionReceipt {
        val lines = normalizeReceiptText(plainText)
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }

        var customerName = ""
        var customerCode = ""
        var salesperson = ""
        var cash = 0.0
        var mailOrder = 0.0
        var transfer = 0.0
        var document = 0.0
        var documentLabel = "EVRAK"
        var total = 0.0
        var remaining = 0.0

        lines.forEach { line ->
            val key = line.substringBefore(":", "").trim().lowercase(Locale.ROOT)
            val value = line.substringAfter(":", "").trim()
            if (!line.contains(":")) {
                return@forEach
            }

            when {
                key.contains("cari isim") || key.contains("cari adi") -> customerName = value
                key.contains("cari kod") -> customerCode = value
                key.contains("plasiyer") -> salesperson = value
                key.contains("kalan bakiye") -> remaining = parseMoney(value)
                key.contains("evrak toplam") || key.contains("toplam") -> total = parseMoney(value)
                key.contains("nakit") -> cash += parseMoney(value)
                key.contains("mail") || key.contains("pos") || key.contains("kart") -> mailOrder += parseMoney(value)
                key.contains("havale") || key.contains("eft") -> transfer += parseMoney(value)
                key.contains("cek") || key.contains("senet") -> {
                    document += parseMoney(value)
                    documentLabel = "EVRAK"
                }
            }
        }

        if (total == 0.0) {
            total = cash + mailOrder + transfer + document
        }

        return CollectionReceipt(
            customerName = customerName,
            customerCode = customerCode,
            salesperson = salesperson,
            cash = cash,
            mailOrder = mailOrder,
            transfer = transfer,
            document = document,
            documentLabel = documentLabel,
            total = total,
            remaining = remaining,
        )
    }

    private data class CollectionReceipt(
        val customerName: String,
        val customerCode: String,
        val salesperson: String,
        val cash: Double,
        val mailOrder: Double,
        val transfer: Double,
        val document: Double,
        val documentLabel: String,
        val total: Double,
        val remaining: Double,
    ) {
        fun valueLines(): List<String> = listOf(customerName, customerCode, salesperson)
            .filter { it.isNotBlank() }

        fun paymentLines(): List<String> = listOf(
            amountLine("NAKIT", cash),
            amountLine("K.KARTI", mailOrder),
            amountLine("HAVALE", transfer),
            amountLine(documentLabel, document),
        )

        fun totalLine(): String = amountLine("TOPLAM", total)

        fun remainingLine(): String = amountLine("KALAN BAKIYE", remaining)

        fun signatureLines(): List<String> = ReceiptSignatureFormatter.lines(customerName, salesperson)

        private fun amountLine(label: String, amount: Double): String {
            val value = formatAmount(amount)
            return "$label: $value"
        }

        private fun formatAmount(amount: Double): String {
            if (amount == 0.0) {
                return "0"
            }
            return String.format(Locale("tr", "TR"), "%.2f", amount).trimEnd('0').trimEnd(',') + " TL"
        }
    }

    private fun parseMoney(value: String): Double {
        val cleaned = value.replace(Regex("[^0-9,.-]"), "")
        if (cleaned.isBlank()) {
            return 0.0
        }
        val normalized = if (cleaned.contains(",")) {
            cleaned.replace(".", "").replace(",", ".")
        } else if (cleaned.contains(".") && cleaned.substringAfterLast(".").length == 3) {
            cleaned.replace(".", "")
        } else {
            cleaned
        }
        return normalized.toDoubleOrNull() ?: 0.0
    }

    private fun wrapLine(value: String, width: Int): List<String> {
        if (value.length <= width) {
            return listOf(value)
        }

        val words = value.split(" ")
        val lines = mutableListOf<String>()
        var current = ""

        for (word in words) {
            val candidate = if (current.isBlank()) word else "$current $word"
            if (candidate.length <= width) {
                current = candidate
            } else {
                if (current.isNotBlank()) {
                    lines.add(current)
                }
                current = word.take(width)
            }
        }

        if (current.isNotBlank()) {
            lines.add(current)
        }

        return lines
    }

    private fun normalizeReceiptText(value: String): String {
        return value
            .replace("ı", "i")
            .replace("İ", "I")
            .replace("ğ", "g")
            .replace("Ğ", "G")
            .replace("ü", "u")
            .replace("Ü", "U")
            .replace("ş", "s")
            .replace("Ş", "S")
            .replace("ö", "o")
            .replace("Ö", "O")
            .replace("ç", "c")
            .replace("Ç", "C")
    }

    private fun String.escapePrinterText(): String {
        return replace("\"", "'")
            .replace("\r", " ")
            .replace("\n", " ")
    }

    private fun escPosDocument(includeLogo: Boolean, content: EscPosWriter.() -> Unit): ByteArray {
        return EscPosWriter(printerCharset, gucsaLogoBitmap).apply {
            init()
            if (includeLogo) {
                writeLogo()
            }
            content()
        }.toByteArray()
    }

    private class EscPosWriter(
        private val charset: Charset,
        private val logoBitmap: ByteArray,
    ) {
        private val buffer = ByteArrayOutputStream()

        fun init() {
            buffer.write(byteArrayOf(0x1B, 0x40))
            buffer.write(byteArrayOf(0x1B, 0x74, 25))
            buffer.write(byteArrayOf(0x1B, 0x33, 24))
            buffer.write(byteArrayOf(0x1D, 0x21, 0))
            buffer.write(byteArrayOf(0x1B, 0x45, 0))
        }

        fun writeLogo() {
            align(1)
            line("GUCSA", align = 1, bold = true, doubleWidth = true, doubleHeight = true)
            line("Filitrecim Grup A.S.", align = 1, bold = true)
            align(0)
        }

        fun line(
            value: String,
            align: Int = 0,
            bold: Boolean = false,
            doubleWidth: Boolean = false,
            doubleHeight: Boolean = false,
        ) {
            align(align)
            bold(bold)
            val size = when {
                doubleWidth && doubleHeight -> 0x11
                doubleWidth -> 0x10
                doubleHeight -> 0x01
                else -> 0x00
            }
            buffer.write(byteArrayOf(0x1D, 0x21, size.toByte()))
            buffer.write(value.toByteArray(charset))
            newline()
            buffer.write(byteArrayOf(0x1D, 0x21, 0))
            bold(false)
            align(0)
        }

        fun separator() {
            line("------------------------------", align = 0, bold = false)
        }

        fun feed(lines: Int) {
            repeat(lines.coerceAtLeast(0)) { newline() }
        }

        fun cut() {
            buffer.write(byteArrayOf(0x1D, 0x56, 0x42, 0))
        }

        fun toByteArray(): ByteArray = buffer.toByteArray()

        private fun align(value: Int) {
            buffer.write(byteArrayOf(0x1B, 0x61, value.coerceIn(0, 2).toByte()))
        }

        private fun bold(enabled: Boolean) {
            buffer.write(byteArrayOf(0x1B, 0x45, if (enabled) 1 else 0))
        }

        private fun newline() {
            buffer.write(byteArrayOf(0x0A))
        }
    }

    private fun BluetoothDevice.safeName(): String {
        return name?.takeIf { it.isNotBlank() } ?: "Bluetooth Yazıcı"
    }

    private fun BluetoothDevice.isLikelyPrinter(): Boolean {
        val upperName = safeName().uppercase(Locale.ROOT)
        return listOf("TSC", "DSI", "PRINTER", "POS", "MTP", "RPP").any { upperName.contains(it) }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
