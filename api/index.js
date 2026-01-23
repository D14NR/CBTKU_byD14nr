'use strict';

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config();
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[WARN] SUPABASE_URL / SUPABASE_KEY belum diset.');
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

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`DB Error (${response.status}): ${errorBody}`);
    }

    return response.status !== 204 ? await response.json() : null;
  } catch (error) {
    console.error('Supabase request error:', error);
    throw error;
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

// ==================== FUNGSI UTAMA ====================

/**
 * Generate mapping dan inisialisasi jawaban gabungan
 */
async function initJawabanGabungan(pid, aid) {
  try {
    console.log(`[GABUNGAN] Inisialisasi untuk peserta ${pid}, agenda ${aid}`);
    
    // 1. Ambil semua mapel untuk agenda ini
    const mapelList = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id,nama_mata_pelajaran',
      id_agenda: `eq.${aid}`,
      status_mapel: `eq.Siap`,
      order: 'id.asc'
    });

    if (!mapelList || mapelList.length === 0) {
      console.log(`[GABUNGAN] Tidak ada mapel untuk agenda ${aid}`);
      return { success: false, message: 'Tidak ada mapel' };
    }

    let totalSoal = 0;
    let soalMappings = [];

    // 2. Loop semua mapel dan ambil semua soal
    for (const mapel of mapelList) {
      const soalList = await supabaseRequest('bank_soal', 'GET', {
        select: 'id,no_soal',
        id_mapel: `eq.${mapel.id}`,
        order: 'no_soal.asc',
        limit: 500
      });

      if (soalList && soalList.length > 0) {
        console.log(`[GABUNGAN] Mapel ${mapel.nama_mata_pelajaran}: ${soalList.length} soal`);
        
        // Simpan mapping
        for (const soal of soalList) {
          soalMappings.push({
            id_agenda: aid,
            id_mapel: mapel.id,
            id_soal: soal.id,
            no_soal_mapel: soal.no_soal || 1,
            no_urut_gabungan: totalSoal + 1
          });
          totalSoal++;
        }
      }
    }

    console.log(`[GABUNGAN] Total soal gabungan: ${totalSoal}`);

    // 3. Simpan mapping ke database (jika belum ada)
    if (soalMappings.length > 0) {
      // Hanya simpan jika belum ada mapping untuk agenda ini
      const existingMapping = await supabaseRequest('soal_mapping_gabungan', 'GET', {
        select: 'id',
        id_agenda: `eq.${aid}`,
        limit: 1
      });

      if (!existingMapping || existingMapping.length === 0) {
        console.log(`[GABUNGAN] Menyimpan ${soalMappings.length} mapping...`);
        for (const mapping of soalMappings) {
          await supabaseRequest('soal_mapping_gabungan', 'POST', null, mapping);
        }
      } else {
        console.log(`[GABUNGAN] Mapping sudah ada untuk agenda ${aid}`);
      }
    }

    // 4. Inisialisasi jawaban gabungan dengan string kosong
    const jawabanAwal = Array(totalSoal).fill('-').join('|');
    
    // Cek apakah sudah ada jawaban gabungan
    const existingJawaban = await supabaseRequest('jawaban_gabungan', 'GET', {
      select: 'id',
      id_peserta: `eq.${pid}`,
      id_agenda: `eq.${aid}`,
      limit: 1
    });

    if (!existingJawaban || existingJawaban.length === 0) {
      await supabaseRequest('jawaban_gabungan', 'POST', null, {
        id_peserta: pid,
        id_agenda: aid,
        jawaban: jawabanAwal,
        total_soal: totalSoal,
        tgljam_update: new Date().toISOString()
      });
      console.log(`[GABUNGAN] Jawaban gabungan diinisialisasi: ${totalSoal} soal`);
    } else {
      console.log(`[GABUNGAN] Jawaban gabungan sudah ada`);
    }

    return { 
      success: true, 
      total_soal: totalSoal,
      jawaban_awal: jawabanAwal
    };
  } catch (error) {
    console.error('[GABUNGAN] Error init jawaban gabungan:', error);
    return { success: false, message: error.message };
  }
}

/**
 * Update jawaban gabungan ketika jawaban per mapel berubah
 */
async function updateJawabanGabungan(pid, aid, mid, jawabanMapelString) {
  try {
    console.log(`[GABUNGAN] Update untuk mapel ${mid}`);
    
    // 1. Ambil semua soal untuk mapel ini
    const soalList = await supabaseRequest('bank_soal', 'GET', {
      select: 'id,no_soal',
      id_mapel: `eq.${mid}`,
      order: 'no_soal.asc',
      limit: 500
    });

    if (!soalList || soalList.length === 0) {
      console.log(`[GABUNGAN] Tidak ada soal untuk mapel ${mid}`);
      return false;
    }

    const jawabanArray = jawabanMapelString.split('|');
    
    // 2. Ambil mapping untuk mapel ini
    const mappingList = await supabaseRequest('soal_mapping_gabungan', 'GET', {
      select: 'id_soal,no_urut_gabungan',
      id_agenda: `eq.${aid}`,
      id_mapel: `eq.${mid}`,
      order: 'no_urut_gabungan.asc'
    });

    if (!mappingList || mappingList.length === 0) {
      console.log(`[GABUNGAN] Mapping tidak ditemukan, init dulu...`);
      const initResult = await initJawabanGabungan(pid, aid);
      if (!initResult.success) return false;
      
      // Coba ambil mapping lagi
      const mappingListNew = await supabaseRequest('soal_mapping_gabungan', 'GET', {
        select: 'id_soal,no_urut_gabungan',
        id_agenda: `eq.${aid}`,
        id_mapel: `eq.${mid}`,
        order: 'no_urut_gabungan.asc'
      });
      
      if (!mappingListNew || mappingListNew.length === 0) {
        console.error(`[GABUNGAN] Masih tidak ada mapping setelah init`);
        return false;
      }
    }

    // 3. Ambil jawaban gabungan saat ini
    const jawabanGabungan = await supabaseRequest('jawaban_gabungan', 'GET', {
      select: 'id,jawaban,total_soal',
      id_peserta: `eq.${pid}`,
      id_agenda: `eq.${aid}`,
      limit: 1
    });

    if (!jawabanGabungan || jawabanGabungan.length === 0) {
      console.log(`[GABUNGAN] Jawaban gabungan tidak ditemukan, init dulu...`);
      const initResult = await initJawabanGabungan(pid, aid);
      if (!initResult.success) return false;
      
      // Coba ambil lagi
      const jawabanGabunganNew = await supabaseRequest('jawaban_gabungan', 'GET', {
        select: 'id,jawaban,total_soal',
        id_peserta: `eq.${pid}`,
        id_agenda: `eq.${aid}`,
        limit: 1
      });
      
      if (!jawabanGabunganNew || jawabanGabunganNew.length === 0) {
        console.error(`[GABUNGAN] Masih tidak ada jawaban gabungan setelah init`);
        return false;
      }
    }

    const jawabanGabunganData = jawabanGabungan[0];
    let jawabanGabunganArray = jawabanGabunganData.jawaban.split('|');

    // 4. Update jawaban untuk setiap soal di mapel ini
    for (let i = 0; i < soalList.length; i++) {
      const soalId = soalList[i].id;
      const jawaban = i < jawabanArray.length ? jawabanArray[i] : '-';
      
      // Cari mapping untuk soal ini
      const mapping = mappingList.find(m => String(m.id_soal) === String(soalId));
      if (mapping) {
        const index = mapping.no_urut_gabungan - 1;
        if (index >= 0 && index < jawabanGabunganArray.length) {
          jawabanGabunganArray[index] = jawaban;
        }
      }
    }

    // 5. Simpan kembali jawaban gabungan
    const jawabanGabunganString = jawabanGabunganArray.join('|');
    
    await supabaseRequest(
      'jawaban_gabungan',
      'PATCH',
      {
        id_peserta: `eq.${pid}`,
        id_agenda: `eq.${aid}`
      },
      {
        jawaban: jawabanGabunganString,
        tgljam_update: new Date().toISOString()
      }
    );

    console.log(`[GABUNGAN] Jawaban gabungan diperbarui: ${totalSoal} soal`);
    return true;
  } catch (error) {
    console.error('[GABUNGAN] Error update jawaban gabungan:', error);
    return false;
  }
}

// ==================== ROUTES ====================

// Test route
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API berjalan',
    timestamp: new Date().toISOString() 
  });
});

/**
 * GET /api/agenda
 */
app.get('/api/agenda', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const data = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'id,agenda_ujian,tgljam_mulai,tgljam_selesai,token_ujian',
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
 * POST /api/register
 */
app.post('/api/register', async (req, res) => {
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

    // Inisialisasi jawaban gabungan untuk peserta baru
    setTimeout(() => {
      if (resData && resData[0]) {
        initJawabanGabungan(resData[0].id, form.agenda_id).then(result => {
          console.log(`[REGISTER] Jawaban gabungan diinit: ${result.success ? 'Success' : 'Failed'}`);
        });
      }
    }, 1000);

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
app.post('/api/login', async (req, res) => {
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
      const ag = await supabaseRequest('agenda_ujian', 'GET', {
        select: 'token_ujian',
        id: `eq.${user.id_agenda}`,
        limit: 1
      });
      if (ag && ag.length > 0) {
        tokenAgenda = ag[0].token_ujian || '';
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
 * GET /api/mapel
 */
app.get('/api/mapel', async (req, res) => {
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
 */
app.post('/api/get-soal', async (req, res) => {
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
      select: 'id,pertanyaan,type_soal,no_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8',
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

    // Pastikan jawaban gabungan sudah diinisialisasi
    const checkGabungan = await supabaseRequest('jawaban_gabungan', 'GET', {
      select: 'id',
      id_peserta: `eq.${peserta_id}`,
      id_agenda: `eq.${agenda_id}`,
      limit: 1
    });

    if (!checkGabungan || checkGabungan.length === 0) {
      console.log(`[GET-SOAL] Inisialisasi jawaban gabungan...`);
      await initJawabanGabungan(peserta_id, agenda_id);
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
    console.error('Error di /get-soal:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/save-jawaban
 */
app.post('/api/save-jawaban', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body || {};
  try {
    if (!pid || !aid || !mid) return res.status(400).json({ success: false, message: 'pid, aid, mid wajib' });

    // 1. Simpan ke tabel jawaban biasa
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

    // 2. Update jawaban gabungan
    await updateJawabanGabungan(pid, aid, mid, jwb);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/selesai-ujian
 */
app.post('/api/selesai-ujian', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body || {};
  try {
    if (!pid || !aid || !mid) return res.status(400).json({ success: false, message: 'pid, aid, mid wajib' });

    // Update jawaban biasa
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

    // Update jawaban gabungan
    await updateJawabanGabungan(pid, aid, mid, jwb);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/jawaban-gabungan
 */
app.get('/api/jawaban-gabungan', async (req, res) => {
  const { pid, aid } = req.query || {};
  try {
    if (!pid || !aid) {
      return res.status(400).json({ success: false, message: 'pid & aid wajib' });
    }

    const result = await supabaseRequest('jawaban_gabungan', 'GET', {
      select: 'jawaban,total_soal,tgljam_update',
      id_peserta: `eq.${pid}`,
      id_agenda: `eq.${aid}`,
      limit: 1
    });

    if (!result || result.length === 0) {
      return res.json({ success: true, jawaban: '', total_soal: 0 });
    }

    const data = result[0];
    
    res.json({
      success: true,
      jawaban: data.jawaban || '',
      total_soal: data.total_soal || 0,
      tgljam_update: data.tgljam_update
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/verify-token
 */
app.get('/api/verify-token', async (req, res) => {
  const { agenda_id, token } = req.query || {};
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
 * POST /api/verify-token (POST version)
 */
app.post('/api/verify-token', async (req, res) => {
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
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server berjalan dengan baik',
    timestamp: new Date().toISOString(),
    features: {
      jawaban_gabungan: 'Aktif',
      format: 'A|B|C|-|D|...'
    },
    env: {
      supabase_url: SUPABASE_URL ? 'Terisi' : 'Kosong',
      node_env: process.env.NODE_ENV || 'development'
    }
  });
});

/**
 * POST /api/init-gabungan
 */
app.post('/api/init-gabungan', async (req, res) => {
  const { pid, aid } = req.body || {};
  try {
    if (!pid || !aid) {
      return res.status(400).json({ success: false, message: 'pid & aid wajib' });
    }

    const result = await initJawabanGabungan(pid, aid);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Handler untuk route yang tidak ditemukan (harus di akhir)
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint tidak ditemukan',
    requested_url: req.originalUrl,
    method: req.method
  });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('Global Error Handler:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Terjadi kesalahan internal server',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Local run
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Server CBT Ujian Online`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`📅 ${new Date().toLocaleString('id-ID')}`);
    console.log(`🌐 Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✅ Test endpoint: http://localhost:${PORT}/api/test`);
    console.log(`✅ Health: http://localhost:${PORT}/api/health`);
    console.log(`✅ Jawaban Gabungan: Format A|B|C|-|...`);
    console.log(`========================================`);
  });
}

module.exports = app;
