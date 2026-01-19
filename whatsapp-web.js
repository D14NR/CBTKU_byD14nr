const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let whatsappClient = null;

function initWhatsApp() {
  whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
  });

  whatsappClient.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
  });

  whatsappClient.on('ready', () => {
    console.log('WhatsApp client is ready!');
  });

  whatsappClient.initialize();
}

async function sendOTPViaWhatsAppWeb(phoneNumber, otp) {
  if (!whatsappClient) return false;
  
  try {
    const chatId = `62${phoneNumber}@c.us`; // Format: 6281234567890@c.us
    const message = `*CBTKU 2026 - Reset Password*\n\nKode OTP Anda: *${otp}*\n\nKode berlaku 10 menit.\n\nJangan bagikan kode ini.`;
    
    await whatsappClient.sendMessage(chatId, message);
    return true;
  } catch (error) {
    console.error('WhatsApp Web error:', error);
    return false;
  }
}
