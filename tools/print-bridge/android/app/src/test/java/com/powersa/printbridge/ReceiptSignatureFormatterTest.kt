package com.powersa.printbridge

import org.junit.Assert.assertEquals
import org.junit.Test

class ReceiptSignatureFormatterTest {
    @Test
    fun `wraps long receiver name instead of truncating it`() {
        val lines = ReceiptSignatureFormatter.lines("deneme hizli satis", "ERZURUM MERKEZ")

        assertEquals(
            listOf(
                "TESLIM ALAN      TESLIM EDEN",
                "deneme hizli     ERZURUM MERKEZ",
                "satis            ",
            ),
            lines,
        )
    }

    @Test
    fun `keeps short names on a compact signature block`() {
        val lines = ReceiptSignatureFormatter.lines("Ali", "Veli")

        assertEquals(
            listOf(
                "TESLIM ALAN      TESLIM EDEN",
                "Ali              Veli",
            ),
            lines,
        )
    }
}
