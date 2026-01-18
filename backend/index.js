// backend/index.js

// Import library yang dibutuhkan
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load variabel lingkungan dari file .env (untuk menyimpan rahasia seperti API key)
dotenv.config();

// Inisialisasi aplikasi Express
const app = express();

// Middleware
app.use(cors()); // Mengizinkan request dari domain lain (misalnya frontend di Vercel)
app.use(express.json()); // Memungkinkan server membaca request body dalam format JSON
app.use(express.static('frontend')); // Menyajikan file statis (index.html) dari folder 'frontend'

// Konfigurasi Supabase dari variabel lingkungan
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

/**
 * Fungsi pembantu untuk melakukan request ke Supabase REST API.
 * Ini adalah versi Node.js dari fungsi supabaseRequest_ di Google Apps Script.
 * @param {string} path - Path endpoint API (contoh: 'peserta').
 * @param {string} method - Metode HTTP (GET, POST, PATCH).
 * @param {Object} query - Objek query parameter untuk filter.
 * @param {Object} body - Body payload untuk POST/PATCH.
 * @return {Object|null} Hasil response dari Supabase dalam bentuk JSON atau null.
 */
async function supabaseRequest(path, method = 'GET', query = null, body = null) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (query) {
    const qs = Object.keys(query).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
    url += `?${qs}`;
  }

  const options = {
    method: method.toUpperCase(),
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    }
  };

  if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  // Di Node.js 18+, fetch sudah built-in. Jika versi lama, gunakan library node-fetch.
  const response = await fetch(url, options);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DB Error (${response.status}): ${errorBody}`);
  }
  
  // Jika tidak ada konten (misalnya saat update tanpa return), kembalikan null
  return response.status !== 204 ? await response.json() : null;
}

// --- API ENDPOINTS ---

// Endpoint untuk mendapatkan daftar agenda ujian yang masih aktif
app.get('/api/agenda', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const data = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'id, agenda_ujian, tgljam_mulai, tgljam_selesai',
      tgljam_selesai: `gte.${now}`, 
      order: 'tgljam_mulai.asc'
    });
    res.json({ success: true, data: data || [] });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk mendaftarkan peserta baru
app.post('/api/register', async (req, res) => {
  const form = req.body;
  try {
    const cek = await supabaseRequest('peserta', 'GET', {
      select: 'id',
      or: `(nis_username.eq.${form.username},no_wa_peserta.eq.${form.no_wa})`,
      limit: 1
    });

    if (cek && cek.length > 0) return res.status(400).json({ success: false, message: 'Username/WA sudah terdaftar!' });

    // TODO: Di produksi, GUNAKAN HASHING untuk password!
    const payload = {
      nama_peserta: form.nama.toUpperCase(),
      nis_username: form.username,
      password: form.password,
      jenjang_studi: form.jenjang,
      kelas: form.kelas,
      asal_sekolah: form.sekolah,
      no_wa_peserta: form.no_wa,
      no_wa_ortu: form.wa_ortu,
      id_agenda: form.agenda_id,
      status: 'Aktif'
    };

    const resData = await supabaseRequest('peserta', 'POST', null, payload);
    
    let namaAgenda = '-';
    if(form.agenda_id) {
       const ag = await supabaseRequest('agenda_ujian', 'GET', {select:'agenda_ujian', id:`eq.${form.agenda_id}`});
       if(ag && ag.length > 0) namaAgenda = ag[0].agenda_ujian;
    }

    res.json({ success: true, data: resData[0], nama_agenda: namaAgenda });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk autentikasi login siswa
app.post('/api/login', async (req, res) => {
  const { u, p } = req.body;
  try {
    const userList = await supabaseRequest('peserta', 'GET', {
      select: '*', or: `(nis_username.eq.${u},no_wa_peserta.eq.${u})`, limit: 1
    });
    if (!userList || userList.length === 0) return res.status(404).json({ success: false, message: 'Akun tidak ditemukan' });
    
    const user = userList[0];
    // TODO: Di produksi, GUNAKAN HASHING untuk password!
    if (user.password !== p) return res.status(401).json({ success: false, message: 'Password salah' });
    if (user.status !== 'Aktif') return res.status(403).json({ success: false, message: 'Akun Nonaktif/Blokir' });
    
    res.json({ success: true, data: user });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk memverifikasi token ujian
app.post('/api/verify-token', async (req, res) => {
  const { agenda_id, token } = req.body;
  try {
    const ag = await supabaseRequest('agenda_ujian', 'GET', { select: 'token_ujian, agenda_ujian', id: `eq.${agenda_id}` });
    if (!ag || ag.length === 0) return res.status(400).json({ success: false, message: 'Agenda error' });
    
    if (String(ag[0].token_ujian).trim().toUpperCase() !== String(token).trim().toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Token Salah!' });
    }
    res.json({ success: true });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk mengambil daftar mata pelajaran
app.get('/api/mapel', async (req, res) => {
  const { agenda_id, peserta_id } = req.query;
  try {
    const mapelList = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id, nama_mata_pelajaran, jumlah_soal, durasi_ujian',
      id_agenda: `eq.${agenda_id}`, 
      status_mapel: 'eq.Siap', 
      order: 'id.asc'
    });

    if (!mapelList) return res.json({ success: true, data: [] });

    const jawabanSiswa = await supabaseRequest('jawaban', 'GET', {
      select: 'id_mapel, status',
      id_agenda: `eq.${agenda_id}`, 
      id_peserta: `eq.${peserta_id}`
    });

    const finalData = mapelList.map(m => {
      const jwb = jawabanSiswa ? jawabanSiswa.find(j => j.id_mapel == m.id) : null;
      return { 
        ...m, 
        status_kerjakan: jwb ? jwb.status : 'Belum' 
      };
    });

    res.json({ success: true, data: finalData });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk mengambil data soal untuk ujian
app.post('/api/get-soal', async (req, res) => {
  const { agenda_id, peserta_id, mapel_id } = req.body;
  try {
    const mapelRes = await supabaseRequest('mata_pelajaran', 'GET', { select: 'id, nama_mata_pelajaran, durasi_ujian', id: `eq.${mapel_id}`, limit: 1 });
    if (!mapelRes || mapelRes.length === 0) throw new Error('Mapel Invalid');
    const mapel = mapelRes[0];

    const pRes = await supabaseRequest('peserta', 'GET', { select: 'nama_peserta', id: `eq.${peserta_id}` });
    const aRes = await supabaseRequest('agenda_ujian', 'GET', { select: 'agenda_ujian', id: `eq.${agenda_id}` });
    const namaP = pRes[0]?.nama_peserta || '-';
    const namaA = aRes[0]?.agenda_ujian || '-';

    // Mengambil semua kolom yang diperlukan untuk semua tipe soal
    const soal = await supabaseRequest('bank_soal', 'GET', {
      select: 'id, pertanyaan, type_soal, pilihan_a, pilihan_b, pilihan_c, pilihan_d, pilihan_e, gambar_url, pernyataan_1, pernyataan_2, pernyataan_3, pernyataan_4, pernyataan_5, pernyataan_6, pernyataan_7, pernyataan_8, pernyataan_kiri_1, pernyataan_kiri_2, pernyataan_kiri_3, pernyataan_kiri_4, pernyataan_kiri_5, pernyataan_kiri_6, pernyataan_kiri_7, pernyataan_kiri_8, pernyataan_kanan_1, pernyataan_kanan_2, pernyataan_kanan_3, pernyataan_kanan_4, pernyataan_kanan_5, pernyataan_kanan_6, pernyataan_kanan_7, pernyataan_kanan_8',
      id_mapel: `eq.${mapel_id}`, order: 'no_soal.asc', limit: 500
    });

    const jRes = await supabaseRequest('jawaban', 'GET', { 
      select: 'id, jawaban, tgljam_mulai, status', 
      id_peserta: `eq.${peserta_id}`, 
      id_mapel: `eq.${mapel_id}`, 
      limit: 1 
    });

    let status = 'Baru', jwbStr = '', waktuMulai = new Date().toISOString();

    if (jRes && jRes.length > 0) {
      status = jRes[0].status === 'Selesai' ? 'Selesai' : 'Lanjut';
      jwbStr = jRes[0].jawaban || '';
      waktuMulai = jRes[0].tgljam_mulai;
    } else {
      jwbStr = Array(soal ? soal.length : 0).fill('-').join('|');
      await supabaseRequest('jawaban', 'POST', null, {
        id_peserta: peserta_id, 
        id_agenda: agenda_id, 
        id_mapel: mapel_id,
        nama_peserta_snap: namaP, 
        nama_agenda_snap: namaA, 
        nama_mapel_snap: mapel.nama_mata_pelajaran,
        jawaban: jwbStr, 
        tgljam_login: waktuMulai, 
        tgljam_mulai: waktuMulai, 
        status: 'Proses'
      });
    }

    res.json({
      success: true, 
      status: status, 
      waktu_mulai: waktuMulai, 
      jawaban_sebelumnya: jwbStr, 
      mapel_detail: mapel, 
      data_soal: soal || []
    });

  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk menyimpan jawaban sementara
app.post('/api/save-jawaban', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body;
  try {
    await supabaseRequest('jawaban', 'PATCH', { 
      id_peserta: `eq.${pid}`, 
      id_mapel: `eq.${mid}`,
      id_agenda: `eq.${aid}`
    }, { jawaban: jwb });
    res.json({ success: true });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});

// Endpoint untuk menyelesaikan ujian
app.post('/api/selesai-ujian', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body;
  try {
    await supabaseRequest('jawaban', 'PATCH', { 
      id_peserta: `eq.${pid}`, 
      id_mapel: `eq.${mid}`,
      id_agenda: `eq.${aid}`
    }, { 
      jawaban: jwb, 
      status: 'Selesai', 
      tgljam_selesai: new Date().toISOString() 
    });
    res.json({ success: true });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ success: false, message: e.message }); 
  }
});


// Jalankan server (ini hanya untuk testing lokal, Vercel akan mengabaikan bagian ini)
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});
