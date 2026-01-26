# CBTKU_byD14nr (Vercel)

## Deploy di Vercel
1. Push repo ini ke GitHub.
2. Import project di Vercel dari GitHub.
3. Set Environment Variables di Vercel (Project Settings → Environment Variables):
   - SUPABASE_URL = https://xxxx.supabase.co
   - SUPABASE_KEY = (JANGAN taruh di repo; gunakan key yang aman)
4. Deploy.

## Catatan Keamanan
- Jangan commit `.env`.
- Jika SUPABASE_KEY pernah bocor, segera rotate/reset di Supabase.

## Endpoint
- GET  /api/agenda
- POST /api/register
- POST /api/login
- POST /api/verify-token
- GET  /api/mapel?agenda_id=...&peserta_id=...
- POST /api/get-soal
- POST /api/save-jawaban
- POST /api/selesai-ujian

package.json
{
  "name": "cbt-2026",
  "version": "1.0.0",
  "description": "Aplikasi CBT-2026",
  "main": "api/index.js",
  "scripts": {
    "start": "node api/index.js"
  },
  "engines": {
    "node": "20.x"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2"
  }
}
