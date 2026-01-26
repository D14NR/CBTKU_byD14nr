'use strict';

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const compression = require('compression');

// Load env
dotenv.config();

const app = express();

// Middleware dengan kompresi
app.use(cors());
app.use(compression({ level: 6 }));
app.use(express.json({ limit: '100kb' }));

// Env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Track usage untuk monitoring
let usageStats = {
  apiCalls: 0,
  bandwidthEstimate: 0,
  startTime: Date.now(),
  lastReset: Date.now()
};

// Reset stats setiap hari
setInterval(() => {
  usageStats.apiCalls = 0;
  usageStats.bandwidthEstimate = 0;
  usageStats.lastReset = Date.now();
  console.log('📊 Usage stats reset');
}, 24 * 60 * 60 * 1000);

// Middleware untuk tracking
app.use((req, res, next) => {
  usageStats.apiCalls++;
  
  const originalSend = res.send;
  res.send = function(body) {
    if (typeof body === 'string') {
      usageStats.bandwidthEstimate += Buffer.byteLength(body, 'utf8');
    } else if (Buffer.isBuffer(body)) {
      usageStats.bandwidthEstimate += body.length;
    } else if (typeof body === 'object') {
      usageStats.bandwidthEstimate += Buffer.byteLength(JSON.stringify(body), 'utf8');
    }
    
    // Check limits
    if (usageStats.apiCalls > 800 && NODE_ENV === 'production') {
      console.warn(`⚠️ API Calls: ${usageStats.apiCalls}/1000 (Vercel limit)`);
    }
    
    if (usageStats.bandwidthEstimate > 1.8 * 1024 * 1024 * 1024) {
      console.warn(`⚠️ Bandwidth: ${Math.round(usageStats.bandwidthEstimate/(1024*1024))}MB/2GB`);
    }
    
    return originalSend.call(this, body);
  };
  
  next();
});

// Rate limiting sederhana
const rateLimitStore = new Map();
const RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 60
};

app.use((req, res, next) => {
  if (NODE_ENV === 'development') return next();
  
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, startTime: now });
  } else {
    const record = rateLimitStore.get(ip);
    
    if (now - record.startTime > RATE_LIMIT.windowMs) {
      record.count = 1;
      record.startTime = now;
    } else if (record.count >= RATE_LIMIT.maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'Terlalu banyak request. Tunggu 1 menit.',
        retryAfter: Math.ceil((record.startTime + RATE_LIMIT.windowMs - now) / 1000)
      });
    } else {
      record.count++;
    }
  }
  
  // Cleanup old records setiap 5 menit
  if (Math.random() < 0.01) {
    const cutoff = now - RATE_LIMIT.windowMs;
    for (const [key, record] of rateLimitStore.entries()) {
      if (record.startTime < cutoff) {
        rateLimitStore.delete(key);
      }
    }
  }
  
  next();
});

// Cache untuk data static
const staticCache = {
  agendas: null,
  agendaMap: new Map(),
  lastUpdated: 0,
  TTL: 5 * 60 * 1000
};

// Helper: request ke Supabase dengan retry
async function supabaseRequest(path, method = 'GET', query = null, body = null, retries = 2) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Server belum dikonfigurasi: SUPABASE_URL / SUPABASE_KEY kosong.');
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const options = {
    method: method.toUpperCase(),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    timeout: 8000
  };

  if (body && (options.method === 'POST' || options.method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        if (response.status === 429) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
          continue;
        }
        const errorBody = await response.text();
        throw new Error(`DB Error (${response.status}): ${errorBody}`);
      }

      if (response.status === 204 || options.method === 'DELETE') {
        return null;
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }
      
      return await response.text();
    } catch (error) {
      if (i === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
    }
  }
}

function safeUser(u) {
  if (!u) return u;
  const copy = { ...u };
  delete copy.password;
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

// Router
const router = express.Router();

/**
 * GET /api/usage - Monitoring endpoint
 */
router.get('/usage', (req, res) => {
  const now = Date.now();
  const hoursRunning = (now - usageStats.startTime) / (1000 * 60 * 60);
  
  res.json({
    success: true,
    stats: {
      api_calls: usageStats.apiCalls,
      bandwidth_mb: Math.round(usageStats.bandwidthEstimate / (1024 * 1024)),
      uptime_hours: hoursRunning.toFixed(2),
      last_reset: new Date(usageStats.lastReset).toISOString(),
      estimated_remaining: {
        api_calls: Math.max(0, 1000 - usageStats.apiCalls),
        bandwidth_mb: Math.max(0, 2048 - Math.round(usageStats.bandwidthEstimate / (1024 * 1024)))
      }
    },
    limits: {
      vercel_daily_calls: 1000,
      supabase_bandwidth_mb: 2048,
      vercel_timeout_seconds: 10
    }
  });
});

/**
 * GET /api/agenda (WITH CACHE)
 */
router.get('/agenda', async (req, res) => {
  try {
    const now = Date.now();
    
    if (staticCache.agendas && (now - staticCache.lastUpdated < staticCache.TTL)) {
      return res.json({ 
        success: true, 
        data: staticCache.agendas,
        cached: true,
        cached_at: new Date(staticCache.lastUpdated).toISOString()
      });
    }
    
    const data = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'id,agenda_ujian,tgljam_mulai,tgljam_selesai,token_ujian',
      tgljam_selesai: `gte.${new Date().toISOString()}`,
      order: 'tgljam_mulai.asc',
      limit: 50
    });
    
    staticCache.agendas = data || [];
    staticCache.agendaMap.clear();
    data?.forEach(agenda => {
      staticCache.agendaMap.set(agenda.id, agenda);
    });
    staticCache.lastUpdated = now;
    
    res.json({ 
      success: true, 
      data: staticCache.agendas,
      cached: false
    });
  } catch (e) {
    console.error('Agenda error:', e);
    if (staticCache.agendas) {
      res.json({ 
        success: true, 
        data: staticCache.agendas,
        cached: true,
        error: 'Using cached data due to error',
        cached_at: new Date(staticCache.lastUpdated).toISOString()
      });
    } else {
      res.status(500).json({ success: false, message: e.message });
    }
  }
});

/**
 * POST /api/register
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

    const payload = {
      nama_peserta: String(form.nama).toUpperCase(),
      nis_username: username,
      password: String(form.password),
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
    let tokenAgenda = '';
    if (form.agenda_id) {
      const agenda = staticCache.agendaMap.get(form.agenda_id.toString());
      if (agenda) {
        namaAgenda = agenda.agenda_ujian;
        tokenAgenda = agenda.token_ujian || '';
      } else {
        const ag = await supabaseRequest('agenda_ujian', 'GET', {
          select: 'agenda_ujian,token_ujian',
          id: `eq.${form.agenda_id}`,
          limit: 1
        });
        if (ag && ag.length > 0) {
          namaAgenda = ag[0].agenda_ujian;
          tokenAgenda = ag[0].token_ujian || '';
        }
      }
    }

    res.json({ 
      success: true, 
      data: safeUser(resData?.[0]), 
      nama_agenda: namaAgenda,
      token_agenda: tokenAgenda
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/login
 */
router.post('/login', async (req, res) => {
  const { u, p } = req.body || {};
  try {
    if (!u || !p) return res.status(400).json({ success: false, message: 'User & password wajib diisi' });

    const userList = await supabaseRequest('peserta', 'GET', {
      select: 'id,nama_peserta,nis_username,jenjang_studi,kelas,asal_sekolah,no_wa_peserta,no_wa_ortu,id_agenda,status,password',
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

    if (String(user.password || '') !== String(p)) {
      return res.status(401).json({ success: false, message: 'Password salah' });
    }

    let tokenAgenda = '';
    if (user.id_agenda) {
      const agenda = staticCache.agendaMap.get(user.id_agenda.toString());
      if (agenda) {
        tokenAgenda = agenda.token_ujian || '';
      } else {
        const ag = await supabaseRequest('agenda_ujian', 'GET', {
          select: 'token_ujian',
          id: `eq.${user.id_agenda}`,
          limit: 1
        });
        if (ag && ag.length > 0) {
          tokenAgenda = ag[0].token_ujian || '';
        }
      }
    }

    res.json({ 
      success: true, 
      data: safeUser(user),
      token_agenda: tokenAgenda
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/forgot-password
 */
router.post('/forgot-password', async (req, res) => {
  const { username } = req.body || {};
  try {
    if (!username) return res.status(400).json({ success: false, message: 'Username/Nomor WA wajib diisi' });

    const userList = await supabaseRequest('peserta', 'GET', {
      select: 'id,nama_peserta,nis_username,no_wa_peserta',
      or: `(nis_username.eq.${username},no_wa_peserta.eq.${username})`,
      limit: 1
    });

    if (!userList || userList.length === 0) {
      return res.status(404).json({ success: false, message: 'Akun tidak ditemukan' });
    }

    const user = userList[0];
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60000);
    
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

    console.log(`OTP untuk ${user.nis_username}: ${otp} (valid 10 menit)`);

    res.json({ 
      success: true, 
      message: 'Kode OTP telah dikirim',
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
 */
router.post('/verify-otp', async (req, res) => {
  const { user_id, otp } = req.body || {};
  try {
    if (!user_id || !otp) return res.status(400).json({ success: false, message: 'User ID dan OTP wajib diisi' });

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

    await supabaseRequest(
      'password_reset',
      'PATCH',
      { id: `eq.${otpData.id}` },
      { status: 'verified', verified_at: new Date().toISOString() }
    );

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 30 * 60000);

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

    await supabaseRequest(
      'peserta',
      'PATCH',
      { id: `eq.${resetData.user_id}` },
      { password: String(new_password) }
    );

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

/**
 * POST /api/cleanup-expired-resets
 */
router.post('/cleanup-expired-resets', async (req, res) => {
  try {
    const now = new Date().toISOString();
    
    await supabaseRequest(
      'password_reset',
      'PATCH',
      {
        status: 'eq.pending',
        expires_at: `lt.${now}`
      },
      { status: 'expired' }
    );
    
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
 */
router.post('/verify-token', async (req, res) => {
  const { agenda_id, token } = req.body || {};
  try {
    if (!agenda_id || !token) return res.status(400).json({ success: false, message: 'agenda_id & token wajib' });

    let agendaToken = '';
    const agenda = staticCache.agendaMap.get(agenda_id.toString());
    if (agenda) {
      agendaToken = agenda.token_ujian || '';
    } else {
      const ag = await supabaseRequest('agenda_ujian', 'GET', {
        select: 'token_ujian,agenda_ujian',
        id: `eq.${agenda_id}`,
        limit: 1
      });
      if (!ag || ag.length === 0) return res.status(400).json({ success: false, message: 'Agenda error' });
      agendaToken = ag[0].token_ujian || '';
    }

    if (String(agendaToken).trim().toUpperCase() !== String(token).trim().toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Token Salah!' });
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/mapel
 */
router.get('/mapel', async (req, res) => {
  const { agenda_id, peserta_id } = req.query || {};
  try {
    if (!agenda_id || !peserta_id) {
      return res.status(400).json({ success: false, message: 'agenda_id & peserta_id wajib' });
    }

    const [mapelList, jawabanSiswa] = await Promise.all([
      supabaseRequest('mata_pelajaran', 'GET', {
        select: 'id,nama_mata_pelajaran,jumlah_soal,durasi_ujian',
        id_agenda: `eq.${agenda_id}`,
        status_mapel: 'eq.Siap',
        order: 'id.asc'
      }),
      supabaseRequest('jawaban', 'GET', {
        select: 'id_mapel,status',
        id_agenda: `eq.${agenda_id}`,
        id_peserta: `eq.${peserta_id}`
      })
    ]);

    const finalData = (mapelList || []).map((m) => {
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
 * POST /api/get-soal-chunked - OPTIMIZED
 */
router.post('/get-soal-chunked', async (req, res) => {
  const { agenda_id, peserta_id, mapel_id, chunk = 0, chunk_size = 30 } = req.body;
  
  try {
    if (!agenda_id || !peserta_id || !mapel_id) {
      return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
    }

    // 1. Get mapel info
    const mapelRes = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id,nama_mata_pelajaran,durasi_ujian',
      id: `eq.${mapel_id}`,
      limit: 1
    });
    
    if (!mapelRes || mapelRes.length === 0) {
      throw new Error('Mapel tidak ditemukan');
    }
    
    const mapel = mapelRes[0];

    // 2. Get user & agenda info (parallel)
    const [userRes, agendaRes, jRes] = await Promise.all([
      supabaseRequest('peserta', 'GET', { 
        select: 'nama_peserta', 
        id: `eq.${peserta_id}`, 
        limit: 1 
      }),
      supabaseRequest('agenda_ujian', 'GET', { 
        select: 'agenda_ujian', 
        id: `eq.${agenda_id}`, 
        limit: 1 
      }),
      supabaseRequest('jawaban', 'GET', {
        select: 'id,jawaban,tgljam_mulai,status',
        id_peserta: `eq.${peserta_id}`,
        id_mapel: `eq.${mapel_id}`,
        limit: 1
      })
    ]);

    let status = 'Baru';
    let jawabanStr = '';
    let waktuMulai = new Date().toISOString();

    if (jRes && jRes.length > 0) {
      status = jRes[0].status === 'Selesai' ? 'Selesai' : 'Lanjut';
      jawabanStr = jRes[0].jawaban || '';
      waktuMulai = jRes[0].tgljam_mulai;
    } else {
      // Create default answer string for 500 questions
      jawabanStr = Array(500).fill('-').join('|');
      await supabaseRequest('jawaban', 'POST', null, {
        id_peserta: peserta_id,
        id_agenda: agenda_id,
        id_mapel: mapel_id,
        nama_peserta_snap: userRes?.[0]?.nama_peserta || '-',
        nama_agenda_snap: agendaRes?.[0]?.agenda_ujian || '-',
        nama_mapel_snap: mapel.nama_mata_pelajaran,
        jawaban: jawabanStr,
        tgljam_login: waktuMulai,
        tgljam_mulai: waktuMulai,
        status: 'Proses'
      });
    }

    // 3. Count total questions
    const countRes = await supabaseRequest('bank_soal', 'GET', {
      select: 'id',
      id_mapel: `eq.${mapel_id}`,
      limit: 1
    });

    const totalSoal = countRes?.length || 0;

    // 4. Get chunk of questions
    const soal = await supabaseRequest('bank_soal', 'GET', {
      select: 'id,pertanyaan,type_soal,no_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8',
      id_mapel: `eq.${mapel_id}`,
      order: 'no_soal.asc',
      limit: chunk_size,
      offset: chunk * chunk_size
    });

    // Optimize Google Drive URLs
    const optimizedSoal = (soal || []).map(s => {
      const optimized = { ...s };
      if (optimized.gambar_url && optimized.gambar_url.includes('drive.google.com')) {
        const match = optimized.gambar_url.match(/\/d\/([^\/]+)/);
        if (match) {
          optimized.thumbnail_url = `https://drive.google.com/thumbnail?id=${match[1]}&sz=w800`;
        }
      }
      return optimized;
    });

    res.json({
      success: true,
      status,
      waktu_mulai: waktuMulai,
      jawaban_sebelumnya: jawabanStr,
      mapel_detail: mapel,
      chunk,
      chunk_size,
      total_chunks: Math.ceil(totalSoal / chunk_size),
      total_soal: totalSoal,
      data_soal: optimizedSoal
    });

  } catch (e) {
    console.error('Chunk error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/get-soal (original - keep for compatibility)
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

    const [pRes, aRes] = await Promise.all([
      supabaseRequest('peserta', 'GET', { select: 'nama_peserta', id: `eq.${peserta_id}`, limit: 1 }),
      supabaseRequest('agenda_ujian', 'GET', { select: 'agenda_ujian', id: `eq.${agenda_id}`, limit: 1 })
    ]);
    
    const namaP = pRes?.[0]?.nama_peserta || '-';
    const namaA = aRes?.[0]?.agenda_ujian || '-';

    const soal = await supabaseRequest('bank_soal', 'GET', {
      select: 'id,pertanyaan,type_soal,no_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8',
      id_mapel: `eq.${mapel_id}`,
      order: 'no_soal.asc',
      limit: 100
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

    // Optimize Google Drive URLs
    const optimizedSoal = (soal || []).map(s => {
      const optimized = { ...s };
      if (optimized.gambar_url && optimized.gambar_url.includes('drive.google.com')) {
        const match = optimized.gambar_url.match(/\/d\/([^\/]+)/);
        if (match) {
          optimized.thumbnail_url = `https://drive.google.com/thumbnail?id=${match[1]}&sz=w800`;
        }
      }
      return optimized;
    });

    res.json({
      success: true,
      status,
      waktu_mulai: waktuMulai,
      jawaban_sebelumnya: jwbStr,
      mapel_detail: mapel,
      data_soal: optimizedSoal || []
    });
  } catch (e) {
    console.error('Error di /get-soal:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/save-jawaban-chunk
 */
router.post('/save-jawaban-chunk', async (req, res) => {
  const { pid, aid, mid, chunk_index, chunk_data } = req.body;
  
  try {
    if (!pid || !aid || !mid || chunk_index === undefined) {
      return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
    }

    const jRes = await supabaseRequest('jawaban', 'GET', {
      select: 'jawaban',
      id_peserta: `eq.${pid}`,
      id_mapel: `eq.${mid}`,
      limit: 1
    });

    if (!jRes || jRes.length === 0) {
      return res.status(404).json({ success: false, message: 'Data jawaban tidak ditemukan' });
    }

    const currentAnswers = jRes[0].jawaban.split('|');
    const CHUNK_SIZE = 30;
    const startIdx = chunk_index * CHUNK_SIZE;
    
    for (let i = 0; i < chunk_data.length && (startIdx + i) < currentAnswers.length; i++) {
      if (chunk_data[i] !== undefined && chunk_data[i] !== null) {
        currentAnswers[startIdx + i] = chunk_data[i];
      }
    }

    const updatedAnswer = currentAnswers.join('|');

    await supabaseRequest(
      'jawaban',
      'PATCH',
      {
        id_peserta: `eq.${pid}`,
        id_mapel: `eq.${mid}`
      },
      { jawaban: updatedAnswer }
    );

    res.json({ 
      success: true, 
      chunk_saved: chunk_index,
      total_answers: currentAnswers.length,
      unsaved_count: currentAnswers.filter(a => a === '-').length
    });

  } catch (e) {
    console.error('Save chunk error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/save-jawaban (original)
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

/**
 * POST /api/cleanup-answers
 */
router.post('/cleanup-answers', async (req, res) => {
  try {
    // Archive jawaban yang sudah selesai > 7 hari
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const oldAnswers = await supabaseRequest('jawaban', 'GET', {
      select: 'id,id_peserta,id_mapel,jawaban,tgljam_selesai,status',
      status: `eq.Selesai`,
      tgljam_selesai: `lt.${sevenDaysAgo}`,
      limit: 100
    });

    let archivedCount = 0;
    if (oldAnswers && oldAnswers.length > 0) {
      for (const answer of oldAnswers) {
        try {
          await supabaseRequest('jawaban_archive', 'POST', null, answer);
          await supabaseRequest('jawaban', 'DELETE', { id: `eq.${answer.id}` });
          archivedCount++;
        } catch (error) {
          console.error('Failed to archive answer:', answer.id, error);
        }
      }
    }

    // Cleanup password_reset yang expired
    const expiredResets = await supabaseRequest('password_reset', 'GET', {
      select: 'id',
      or: `(status.eq.expired,expires_at.lt.${new Date().toISOString()})`,
      limit: 100
    });

    let cleanedCount = 0;
    if (expiredResets && expiredResets.length > 0) {
      for (const reset of expiredResets) {
        try {
          await supabaseRequest('password_reset', 'DELETE', { id: `eq.${reset.id}` });
          cleanedCount++;
        } catch (error) {
          console.error('Failed to delete reset:', reset.id, error);
        }
      }
    }

    res.json({ 
      success: true, 
      archived: archivedCount,
      cleaned: cleanedCount,
      message: `Archived ${archivedCount} answers, cleaned ${cleanedCount} reset records`
    });

  } catch (e) {
    console.error('Cleanup error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/optimize-image
 */
router.get('/optimize-image', async (req, res) => {
  const { url } = req.query;
  
  if (!url || !url.includes('drive.google.com')) {
    return res.json({ success: false, message: 'URL Google Drive diperlukan' });
  }

  try {
    let fileId;
    
    const match1 = url.match(/\/d\/([^\/]+)/);
    if (match1) {
      fileId = match1[1];
    }
    
    const match2 = url.match(/[?&]id=([^&]+)/);
    if (match2) {
      fileId = match2[1];
    }
    
    if (!fileId) {
      return res.json({ success: false, message: 'Tidak dapat mengekstrak file ID' });
    }
    
    const optimized = {
      original: url,
      thumbnail: `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`,
      medium: `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`,
      large: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`,
      download: `https://drive.google.com/uc?export=download&id=${fileId}`,
      file_id: fileId
    };
    
    res.json({ success: true, data: optimized });
    
  } catch (e) {
    console.error('Optimize error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/batch-register (for testing only)
 */
router.post('/batch-register', async (req, res) => {
  if (NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, message: 'Hanya untuk development' });
  }
  
  const { count = 10, agenda_id } = req.body;
  
  if (!agenda_id) {
    return res.status(400).json({ success: false, message: 'agenda_id diperlukan' });
  }
  
  try {
    const results = [];
    const batchSize = 5;
    
    for (let i = 0; i < count; i += batchSize) {
      const batchPromises = [];
      
      for (let j = 0; j < batchSize && (i + j) < count; j++) {
        const userNum = i + j + 1;
        const payload = {
          agenda_id: agenda_id,
          nama: `User Test ${userNum}`,
          jenjang: 'SMA',
          kelas: `X IPA ${(userNum % 5) + 1}`,
          sekolah: 'SMA Test',
          no_wa: `6281234567${String(userNum).padStart(3, '0')}`,
          wa_ortu: `6287654321${String(userNum).padStart(3, '0')}`,
          password: 'password123',
          username: `testuser${userNum}`
        };
        
        batchPromises.push(
          supabaseRequest('peserta', 'POST', null, payload)
            .then(data => ({ success: true, data: data?.[0] }))
            .catch(error => ({ success: false, error: error.message }))
        );
      }
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const successCount = results.filter(r => r.success).length;
    
    res.json({
      success: true,
      registered: successCount,
      failed: count - successCount,
      results: results.slice(0, 10)
    });
    
  } catch (e) {
    console.error('Batch register error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  
  res.json({
    success: true,
    message: 'Server berjalan dengan baik',
    timestamp: new Date().toISOString(),
    environment: {
      node_env: NODE_ENV,
      supabase_configured: !!(SUPABASE_URL && SUPABASE_KEY)
    },
    stats: {
      api_calls: usageStats.apiCalls,
      bandwidth_mb: Math.round(usageStats.bandwidthEstimate / (1024 * 1024)),
      uptime_hours: (Date.now() - usageStats.startTime) / (1000 * 60 * 60)
    },
    memory: {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`
    }
  });
});

/**
 * GET /api/stats/agenda/:id
 */
router.get('/stats/agenda/:id', async (req, res) => {
  try {
    const agendaId = req.params.id;
    
    const [pesertaCount, mapelCount, jawabanCount] = await Promise.all([
      supabaseRequest('peserta', 'GET', {
        select: 'id',
        id_agenda: `eq.${agendaId}`,
        limit: 1
      }),
      supabaseRequest('mata_pelajaran', 'GET', {
        select: 'id',
        id_agenda: `eq.${agendaId}`,
        limit: 1
      }),
      supabaseRequest('jawaban', 'GET', {
        select: 'id',
        id_agenda: `eq.${agendaId}`,
        limit: 1
      })
    ]);
    
    res.json({
      success: true,
      agenda_id: agendaId,
      stats: {
        peserta: pesertaCount?.length || 0,
        mapel: mapelCount?.length || 0,
        jawaban: jawabanCount?.length || 0
      }
    });
  } catch (e) {
    console.error('Stats error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.use('/api', router);

// Handler untuk route yang tidak ditemukan
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint tidak ditemukan',
    path: req.path
  });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Global Error Handler:', {
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
    path: req.path,
    ip: req.ip
  });
  
  res.status(500).json({ 
    success: false, 
    message: 'Terjadi kesalahan internal server',
    error: NODE_ENV === 'development' ? err.message : undefined
  });
});

// Local run
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  
  // Schedule cleanup setiap hari jam 3 pagi
  if (NODE_ENV === 'production') {
    setInterval(async () => {
      try {
        console.log('Running scheduled cleanup...');
        // Anda bisa memanggil cleanup endpoint di sini
      } catch (error) {
        console.error('Scheduled cleanup failed:', error);
      }
    }, 24 * 60 * 60 * 1000);
  }
  
  app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Server CBT Ujian Online (OPTIMIZED)`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`📅 ${new Date().toLocaleString('id-ID')}`);
    console.log(`🌐 Mode: ${NODE_ENV}`);
    console.log(`✅ Health check: http://localhost:${PORT}/api/health`);
    console.log(`📊 Usage stats: http://localhost:${PORT}/api/usage`);
    console.log(`========================================`);
  });
}

module.exports = app;
