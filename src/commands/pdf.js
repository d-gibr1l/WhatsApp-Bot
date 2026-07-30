import { downloadMediaMessage } from "@whiskeysockets/baileys";
import PDFDocument from "pdfkit";
import { replyMsg, reactMsg, failMsg } from "./helpers.js";

async function getMediaBuffer(msg) {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const hasImage = !!(msg.message?.imageMessage || quotedMsg?.imageMessage);
  
  if (!hasImage) return null;
  const msgToDownload = quotedMsg?.imageMessage ? { key: msg.key, message: quotedMsg } : msg;
  const buffer = await downloadMediaMessage(msgToDownload, "buffer", {});
  return buffer;
}

export const pdfCommands = {
  pdf: {
    adminOnly: false,
    requiresArgs: false,
    description: "Convert an image to a PDF document",
    usage: "!pdf",
    examples: ["Reply to an image with !pdf"],
    handler: async (sock, msg, args, from, prefix) => {
      const buffer = await getMediaBuffer(msg);
      if (!buffer) return replyMsg(sock, from, msg, `📖 *${prefix}pdf*\n\nReply to an image with *${prefix}pdf* to convert it into a PDF file.`);

      await reactMsg(sock, from, msg, "⏳");

      try {
        const pdfBuffer = await new Promise((resolve, reject) => {
          try {
            const doc = new PDFDocument({ margin: 0 }); // No margins, so image can take up the whole page if needed
            const chunks = [];
            doc.on("data", chunk => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            
            // Add the image to the document
            doc.image(buffer, 0, 0, {
              fit: [doc.page.width, doc.page.height],
              align: 'center',
              valign: 'center'
            });
            
            doc.end();
          } catch (err) {
            reject(err);
          }
        });

        // Send the PDF back to the user
        await sock.sendMessage(from, {
          document: pdfBuffer,
          mimetype: "application/pdf",
          fileName: `converted_${Date.now()}.pdf`,
          caption: "Here is your PDF document!"
        }, { quoted: msg });

        await reactMsg(sock, from, msg, "✅");
      } catch (err) {
        console.error("❌ PDF conversion error:", err.message);
        failMsg(sock, from, msg, "Failed to convert the image to PDF. Make sure it's a valid image file.");
      }
    },
  },
};
