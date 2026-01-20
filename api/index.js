'use strict';

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');

// Load env dari .env saat lokal. Di Vercel, env diambil dari Environment Variables.
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[WARN] SUPABASE_URL / SUPABASE_KEY belum diset. Set env di Vercel atau .env saat lokal.');
}

// Helper: request ke Supabase REST
async function supabaseRequest(path, method = 'GET', query = null, body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Server belum dikonfigurasi: SUPABASE_URL / SUPABASE_KEY kosong.');
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }
  }

  const options = {
    method: method.toUpperCase(),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  };

  if (body && (options.method === 'POST' || options.method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DB Error (${response.status}): ${errorBody}`);
  }

  return response.status !== 204 ? await response.json() : null;
}

function safeUser(u) {
  if (!u) return u;
  const copy = { ...u };
  delete copy.password; // jangan pernah kirim password ke client
  return copy;
}

function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === '') {
      return `Field "${f}" wajib diisi`;
    }
  }
  return null;
}

// Router /api
const router = express.Router();

/**
 * GET /api/agenda
 */
router.get('/agenda', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const data = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'id,agenda_ujian,tgljam_mulai,tgljam_selesai',
      tgljam_selesai: `gte.${now}`,
      order: 'tgljam_mulai.asc'
    });
    res.json({ success: true, data: data || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/register  (PLAINTEXT PASSWORD)
 */
router.post('/register', async (req, res) => {
  const form = req.body || {};
  try {
    const err = requireFields(form, [
      'agenda_id',
      'nama',
      'jenjang',
      'kelas',
      'sekolah',
      'no_wa',
      'wa_ortu',
      'password',
      'username'
    ]);
    if (err) return res.status(400).json({ success: false, message: err });

    const username = String(form.username).trim();
    const noWa = String(form.no_wa).trim();

    // basic sanitasi agar query Supabase "or" tidak aneh
    if (!/^[0-9A-Za-z_+.-]{3,50}$/.test(username) && !/^[0-9]{8,20}$/.test(username)) {
      return res.status(400).json({ success: false, message: 'Username tidak valid' });
    }

    const cek = await supabaseRequest('peserta', 'GET', {
      select: 'id',
      or: `(nis_username.eq.${username},no_wa_peserta.eq.${noWa})`,
      limit: 1
    });

    if (cek && cek.length > 0) {
      return res.status(400).json({ success: false, message: 'Username/WA sudah terdaftar!' });
    }

    // TANPA HASH: simpan password apa adanya (plaintext)
    const payload = {
      nama_peserta: String(form.nama).toUpperCase(),
      nis_username: username,
      password: String(form.password), // PLAINTEXT
      jenjang_studi: String(form.jenjang),
      kelas: String(form.kelas),
      asal_sekolah: String(form.sekolah),
      no_wa_peserta: noWa,
      no_wa_ortu: String(form.wa_ortu),
      id_agenda: form.agenda_id,
      status: 'Aktif'
    };

    const resData = await supabaseRequest('peserta', 'POST', null, payload);

    let namaAgenda = '-';
    if (form.agenda_id) {
      const ag = await supabaseRequest('agenda_ujian', 'GET', {
        select: 'agenda_ujian',
        id: `eq.${form.agenda_id}`,
        limit: 1
      });
      if (ag && ag.length > 0) namaAgenda = ag[0].agenda_ujian;
    }

    res.json({ success: true, data: safeUser(resData?.[0]), nama_agenda: namaAgenda });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/login  (PLAINTEXT PASSWORD)
 * body: { u, p }
 */
router.post('/login', async (req, res) => {
  const { u, p } = req.body || {};
  try {
    if (!u || !p) return res.status(400).json({ success: false, message: 'User & password wajib diisi' });

    const userList = await supabaseRequest('peserta', 'GET', {
      // ambil kolom yang perlu + password untuk dicek
      select:
        'id,nama_peserta,nis_username,jenjang_studi,kelas,asal_sekolah,no_wa_peserta,no_wa_ortu,id_agenda,status,password',
      or: `(nis_username.eq.${u},no_wa_peserta.eq.${u})`,
      limit: 1
    });

    if (!userList || userList.length === 0) {
      return res.status(404).json({ success: false, message: 'Akun tidak ditemukan' });
    }

    const user = userList[0];

    if (user.status !== 'Aktif') {
      return res.status(403).json({ success: false, message: 'Akun Nonaktif/Blokir' });
    }

    // TANPA HASH: cocokkan string langsung
    if (String(user.password || '') !== String(p)) {
      return res.status(401).json({ success: false, message: 'Password salah' });
    }

    res.json({ success: true, data: safeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/forgot-password
 * Minta reset password (kirim kode OTP)
 */
router.post('/forgot-password', async (req, res) => {
  const { username } = req.body || {};
  try {
    if (!username) return res.status(400).json({ success: false, message: 'Username/Nomor WA wajib diisi' });

    // Cari user berdasarkan username/no WA
    const userList = await supabaseRequest('peserta', 'GET', {
      select: 'id,nama_peserta,nis_username,no_wa_peserta',
      or: `(nis_username.eq.${username},no_wa_peserta.eq.${username})`,
      limit: 1
    });

    if (!userList || userList.length === 0) {
      return res.status(404).json({ success: false, message: 'Akun tidak ditemukan' });
    }

    const user = userList[0];
    
    // Generate OTP 6 digit
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60000); // 10 menit dari sekarang
    
    // Simpan OTP ke database
    await supabaseRequest(
      'password_reset',
      'POST',
      null,
      {
        user_id: user.id,
        username: user.nis_username,
        otp_code: otp,
        expires_at: otpExpiry.toISOString(),
        status: 'pending',
        created_at: new Date().toISOString()
      }
    );

    // NOTE: Dalam implementasi nyata, OTP dikirim via SMS/WhatsApp/Email
    // Di sini kita hanya return di response untuk testing
    console.log(`OTP untuk ${user.nis_username}: ${otp} (valid 10 menit)`);

    res.json({ 
      success: true, 
      message: 'Kode OTP telah dikirim',
      // Hanya untuk development/testing, hapus di production
      otp: process.env.NODE_ENV === 'development' ? otp : undefined,
      user_id: user.id,
      nama: user.nama_peserta
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/verify-otp
 * Verifikasi OTP
 */
router.post('/verify-otp', async (req, res) => {
  const { user_id, otp } = req.body || {};
  try {
    if (!user_id || !otp) return res.status(400).json({ success: false, message: 'User ID dan OTP wajib diisi' });

    // Cari OTP yang valid
    const otpList = await supabaseRequest('password_reset', 'GET', {
      select: 'id,otp_code,expires_at,status',
      user_id: `eq.${user_id}`,
      otp_code: `eq.${otp}`,
      status: `eq.pending`,
      order: 'created_at.desc',
      limit: 1
    });

    if (!otpList || otpList.length === 0) {
      return res.status(400).json({ success: false, message: 'Kode OTP tidak valid' });
    }

    const otpData = otpList[0];
    const now = new Date();
    const expiryDate = new Date(otpData.expires_at);

    if (now > expiryDate) {
      await supabaseRequest(
        'password_reset',
        'PATCH',
        { id: `eq.${otpData.id}` },
        { status: 'expired' }
      );
      return res.status(400).json({ success: false, message: 'Kode OTP sudah kadaluarsa' });
    }

    // Update status OTP menjadi verified
    await supabaseRequest(
      'password_reset',
      'PATCH',
      { id: `eq.${otpData.id}` },
      { status: 'verified', verified_at: new Date().toISOString() }
    );

    // Generate reset token untuk reset password
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 30 * 60000); // 30 menit

    await supabaseRequest(
      'password_reset',
      'PATCH',
      { id: `eq.${otpData.id}` },
      { 
        reset_token: resetToken,
        token_expires_at: tokenExpiry.toISOString()
      }
    );

    res.json({ 
      success: true, 
      message: 'OTP berhasil diverifikasi',
      reset_token: resetToken,
      token_expires_at: tokenExpiry.toISOString()
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/reset-password
 * Reset password dengan token
 */
router.post('/reset-password', async (req, res) => {
  const { reset_token, new_password, confirm_password } = req.body || {};
  try {
    if (!reset_token || !new_password || !confirm_password) {
      return res.status(400).json({ success: false, message: 'Token dan password baru wajib diisi' });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ success: false, message: 'Password baru tidak cocok' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
    }

    // Cari reset token yang valid
    const resetList = await supabaseRequest('password_reset', 'GET', {
      select: 'id,user_id,reset_token,token_expires_at,status',
      reset_token: `eq.${reset_token}`,
      status: `eq.verified`,
      limit: 1
    });

    if (!resetList || resetList.length === 0) {
      return res.status(400).json({ success: false, message: 'Token reset tidak valid' });
    }

    const resetData = resetList[0];
    const now = new Date();
    const tokenExpiry = new Date(resetData.token_expires_at);

    if (now > tokenExpiry) {
      await supabaseRequest(
        'password_reset',
        'PATCH',
        { id: `eq.${resetData.id}` },
        { status: 'expired' }
      );
      return res.status(400).json({ success: false, message: 'Token reset sudah kadaluarsa' });
    }

    // TANPA HASH: simpan password plaintext
    // Update password user
    await supabaseRequest(
      'peserta',
      'PATCH',
      { id: `eq.${resetData.user_id}` },
      { password: String(new_password) } // PLAINTEXT
    );

    // Update status reset menjadi completed
    await supabaseRequest(
      'password_reset',
      'PATCH',
      { id: `eq.${resetData.id}` },
      { 
        status: 'completed',
        completed_at: new Date().toISOString()
      }
    );

    res.json({ 
      success: true, 
      message: 'Password berhasil direset. Silakan login dengan password baru.' 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Endpoint untuk membersihkan data reset password yang expired
router.post('/cleanup-expired-resets', async (req, res) => {
  try {
    const now = new Date().toISOString();
    
    // Update status yang expired
    await supabaseRequest(
      'password_reset',
      'PATCH',
      {
        status: 'eq.pending',
        expires_at: `lt.${now}`
      },
      { status: 'expired' }
    );
    
    // Hapus data yang sudah completed lebih dari 7 hari
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseRequest(
      'password_reset',
      'DELETE',
      {
        status: 'eq.completed',
        completed_at: `lt.${sevenDaysAgo}`
      }
    );
    
    res.json({ success: true, message: 'Cleanup berhasil' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/verify-token
 * body: { agenda_id, token }
 */
router.post('/verify-token', async (req, res) => {
  const { agenda_id, token } = req.body || {};
  try {
    if (!agenda_id || !token) return res.status(400).json({ success: false, message: 'agenda_id & token wajib' });

    const ag = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'token_ujian,agenda_ujian',
      id: `eq.${agenda_id}`,
      limit: 1
    });

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

/**
 * GET /api/mapel?agenda_id=...&peserta_id=...
 */
router.get('/mapel', async (req, res) => {
  const { agenda_id, peserta_id } = req.query || {};
  try {
    if (!agenda_id || !peserta_id) {
      return res.status(400).json({ success: false, message: 'agenda_id & peserta_id wajib' });
    }

    const mapelList = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id,nama_mata_pelajaran,jumlah_soal,durasi_ujian',
      id_agenda: `eq.${agenda_id}`,
      status_mapel: 'eq.Siap',
      order: 'id.asc'
    });

    if (!mapelList) return res.json({ success: true, data: [] });

    const jawabanSiswa = await supabaseRequest('jawaban', 'GET', {
      select: 'id_mapel,status',
      id_agenda: `eq.${agenda_id}`,
      id_peserta: `eq.${peserta_id}`
    });

    const finalData = mapelList.map((m) => {
      const jwb = jawabanSiswa ? jawabanSiswa.find((j) => String(j.id_mapel) === String(m.id)) : null;
      return { ...m, status_kerjakan: jwb ? jwb.status : 'Belum' };
    });

    res.json({ success: true, data: finalData });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/get-soal
 * body: { agenda_id, peserta_id, mapel_id }
 */
router.post('/get-soal', async (req, res) => {
  const { agenda_id, peserta_id, mapel_id } = req.body || {};
  try {
    if (!agenda_id || !peserta_id || !mapel_id) {
      return res.status(400).json({ success: false, message: 'agenda_id, peserta_id, mapel_id wajib' });
    }

    const mapelRes = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id,nama_mata_pelajaran,durasi_ujian',
      id: `eq.${mapel_id}`,
      limit: 1
    });
    if (!mapelRes || mapelRes.length === 0) throw new Error('Mapel Invalid');
    const mapel = mapelRes[0];

    const pRes = await supabaseRequest('peserta', 'GET', { select: 'nama_peserta', id: `eq.${peserta_id}`, limit: 1 });
    const aRes = await supabaseRequest('agenda_ujian', 'GET', { select: 'agenda_ujian', id: `eq.${agenda_id}`, limit: 1 });
    const namaP = pRes?.[0]?.nama_peserta || '-';
    const namaA = aRes?.[0]?.agenda_ujian || '-';

    const soal = await supabaseRequest('bank_soal', 'GET', {
      select:
        'id,pertanyaan,type_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8',
      id_mapel: `eq.${mapel_id}`,
      order: 'no_soal.asc',
      limit: 500
    });

    const jRes = await supabaseRequest('jawaban', 'GET', {
      select: 'id,jawaban,tgljam_mulai,status',
      id_peserta: `eq.${peserta_id}`,
      id_mapel: `eq.${mapel_id}`,
      limit: 1
    });

    let status = 'Baru';
    let jwbStr = '';
    let waktuMulai = new Date().toISOString();

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
      status,
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

/**
 * POST /api/save-jawaban
 * body: { pid, aid, mid, jwb }
 */
router.post('/save-jawaban', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body || {};
  try {
    if (!pid || !aid || !mid) return res.status(400).json({ success: false, message: 'pid, aid, mid wajib' });

    await supabaseRequest(
      'jawaban',
      'PATCH',
      {
        id_peserta: `eq.${pid}`,
        id_mapel: `eq.${mid}`,
        id_agenda: `eq.${aid}`
      },
      { jawaban: jwb }
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/selesai-ujian
 * body: { pid, aid, mid, jwb }
 */
router.post('/selesai-ujian', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body || {};
  try {
    if (!pid || !aid || !mid) return res.status(400).json({ success: false, message: 'pid, aid, mid wajib' });

    await supabaseRequest(
      'jawaban',
      'PATCH',
      {
        id_peserta: `eq.${pid}`,
        id_mapel: `eq.${mid}`,
        id_agenda: `eq.${aid}`
      },
      {
        jawaban: jwb,
        status: 'Selesai',
        tgljam_selesai: new Date().toISOString()
      }
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.use('/api', router);

// Local run (tidak dipakai di Vercel serverless)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}

module.exports = app;
