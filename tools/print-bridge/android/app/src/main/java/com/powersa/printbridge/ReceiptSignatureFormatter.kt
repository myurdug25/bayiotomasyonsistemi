package com.powersa.printbridge

object ReceiptSignatureFormatter {
    private const val LeftWidth = 15
    private const val GapWidth = 2
    private const val RightWidth = 15

    fun lines(receiver: String, sender: String): List<String> {
        val leftLines = wrap(receiver.ifBlank { "-" }, LeftWidth)
        val rightLines = wrap(sender.ifBlank { "-" }, RightWidth)
        val maxRows = maxOf(leftLines.size, rightLines.size)

        return listOf(twoColumn("TESLIM ALAN", "TESLIM EDEN")) +
            (0 until maxRows).map { index ->
                twoColumn(
                    leftLines.getOrElse(index) { "" },
                    rightLines.getOrElse(index) { "" },
                )
            }
    }

    private fun twoColumn(left: String, right: String): String {
        return left.padEnd(LeftWidth + GapWidth).take(LeftWidth + GapWidth) + right
    }

    private fun wrap(value: String, width: Int): List<String> {
        val words = value.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        if (words.isEmpty()) {
            return listOf("-")
        }

        val lines = mutableListOf<String>()
        var current = ""
        words.forEach { word ->
            if (word.length > width) {
                if (current.isNotBlank()) {
                    lines.add(current)
                    current = ""
                }
                word.chunked(width).forEach { lines.add(it) }
                return@forEach
            }

            val candidate = if (current.isBlank()) word else "$current $word"
            if (candidate.length <= width) {
                current = candidate
            } else {
                lines.add(current)
                current = word
            }
        }

        if (current.isNotBlank()) {
            lines.add(current)
        }

        return lines
    }
}
