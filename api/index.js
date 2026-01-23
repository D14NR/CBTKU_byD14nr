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

// Helper: Generate mapping nomor urut gabungan
async function generateSoalMapping(agenda_id) {
  try {
    console.log(`[MAPPING] Generating mapping untuk agenda ${agenda_id}`);
    
    // Ambil semua mapel untuk agenda ini
    const mapelList = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id,nama_mata_pelajaran',
      id_agenda: `eq.${agenda_id}`,
      status_mapel: `eq.Siap`,
      order: 'id.asc'
    });

    if (!mapelList || mapelList.length === 0) {
      console.log(`[MAPPING] Tidak ada mapel untuk agenda ${agenda_id}`);
      return { success: false, message: 'Tidak ada mapel' };
    }

    let currentNoUrut = 1;
    const allMappings = [];

    // Untuk setiap mapel, ambil semua soal
    for (const mapel of mapelList) {
      const soalList = await supabaseRequest('bank_soal', 'GET', {
        select: 'id,no_soal',
        id_mapel: `eq.${mapel.id}`,
        order: 'no_soal.asc',
        limit: 500
      });

      if (soalList && soalList.length > 0) {
        console.log(`[MAPPING] Mapel ${mapel.nama_mata_pelajaran}: ${soalList.length} soal`);
        
        // Buat mapping untuk setiap soal
        for (const soal of soalList) {
          const mapping = {
            id_agenda: agenda_id,
            id_mapel: mapel.id,
            id_soal: soal.id,
            no_soal_mapel: soal.no_soal || 1,
            no_urut_gabungan: currentNoUrut,
            nama_mapel: mapel.nama_mata_pelajaran
          };
          
          allMappings.push(mapping);
          currentNoUrut++;
        }
      }
    }

    console.log(`[MAPPING] Total mapping dibuat: ${allMappings.length}`);

    // Simpan mapping ke database
    if (allMappings.length > 0) {
      // Hapus mapping lama jika ada
      await supabaseRequest('soal_mapping_gabungan', 'DELETE', {
        id_agenda: `eq.${agenda_id}`
      });

      // Simpan mapping baru
      for (const mapping of allMappings) {
        await supabaseRequest('soal_mapping_gabungan', 'POST', null, mapping);
      }
    }

    return { 
      success: true, 
      total_mapping: allMappings.length,
      mappings: allMappings 
    };
  } catch (error) {
    console.error('[MAPPING] Error generating mapping:', error);
    return { success: false, message: error.message };
  }
}

// Helper: Update jawaban gabungan
async function updateJawabanGabungan(pid, aid, mid, soal_id, jawaban, nomor_soal_mapel, mapel_nama) {
  try {
    // Cari mapping untuk soal ini
    const mapping = await supabaseRequest('soal_mapping_gabungan', 'GET', {
      select: 'no_urut_gabungan',
      id_agenda: `eq.${aid}`,
      id_mapel: `eq.${mid}`,
      id_soal: `eq.${soal_id}`,
      limit: 1
    });

    if (!mapping || mapping.length === 0) {
      console.log(`[GABUNGAN] Mapping tidak ditemukan, generate ulang...`);
      const mappingResult = await generateSoalMapping(aid);
      if (!mappingResult.success) {
        console.error('[GABUNGAN] Gagal generate mapping');
        return false;
      }
      
      // Coba lagi setelah generate
      const mappingNew = await supabaseRequest('soal_mapping_gabungan', 'GET', {
        select: 'no_urut_gabungan',
        id_agenda: `eq.${aid}`,
        id_mapel: `eq.${mid}`,
        id_soal: `eq.${soal_id}`,
        limit: 1
      });

      if (!mappingNew || mappingNew.length === 0) {
        console.error(`[GABUNGAN] Masih tidak ditemukan mapping untuk soal ${soal_id}`);
        return false;
      }

      const noUrut = mappingNew[0].no_urut_gabungan;
      
      // Ambil data peserta
      const peserta = await supabaseRequest('peserta', 'GET', {
        select: 'nama_peserta',
        id: `eq.${pid}`,
        limit: 1
      });
      
      const namaPeserta = peserta && peserta.length > 0 ? peserta[0].nama_peserta : 'Unknown';
      
      // Ambil data agenda
      const agenda = await supabaseRequest('agenda_ujian', 'GET', {
        select: 'agenda_ujian',
        id: `eq.${aid}`,
        limit: 1
      });
      
      const namaAgenda = agenda && agenda.length > 0 ? agenda[0].agenda_ujian : 'Unknown';

      // Update atau insert jawaban gabungan
      await supabaseRequest('jawaban_gabungan', 'POST', null, {
        id_peserta: pid,
        id_agenda: aid,
        nama_peserta: namaPeserta,
        nama_agenda: namaAgenda,
        no_urut: noUrut,
        jawaban: jawaban,
        id_mapel: mid,
        id_soal: soal_id,
        tgljam_update: new Date().toISOString()
      });

      console.log(`[GABUNGAN] Jawaban gabungan disimpan: no_urut=${noUrut}, jawaban=${jawaban}`);
      return true;
    }

    const noUrut = mapping[0].no_urut_gabungan;
    
    // Cek apakah sudah ada jawaban untuk no_urut ini
    const existing = await supabaseRequest('jawaban_gabungan', 'GET', {
      select: 'id',
      id_peserta: `eq.${pid}`,
      id_agenda: `eq.${aid}`,
      no_urut: `eq.${noUrut}`,
      limit: 1
    });

    // Ambil data peserta
    const peserta = await supabaseRequest('peserta', 'GET', {
      select: 'nama_peserta',
      id: `eq.${pid}`,
      limit: 1
    });
    
    const namaPeserta = peserta && peserta.length > 0 ? peserta[0].nama_peserta : 'Unknown';
    
    // Ambil data agenda
    const agenda = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'agenda_ujian',
      id: `eq.${aid}`,
      limit: 1
    });
    
    const namaAgenda = agenda && agenda.length > 0 ? agenda[0].agenda_ujian : 'Unknown';

    if (existing && existing.length > 0) {
      // Update jawaban yang sudah ada
      await supabaseRequest(
        'jawaban_gabungan',
        'PATCH',
        {
          id_peserta: `eq.${pid}`,
          id_agenda: `eq.${aid}`,
          no_urut: `eq.${noUrut}`
        },
        {
          jawaban: jawaban,
          id_mapel: mid,
          id_soal: soal_id,
          tgljam_update: new Date().toISOString()
        }
      );
    } else {
      // Insert jawaban baru
      await supabaseRequest('jawaban_gabungan', 'POST', null, {
        id_peserta: pid,
        id_agenda: aid,
        nama_peserta: namaPeserta,
        nama_agenda: namaAgenda,
        no_urut: noUrut,
        jawaban: jawaban,
        id_mapel: mid,
        id_soal: soal_id,
        tgljam_update: new Date().toISOString()
      });
    }

    console.log(`[GABUNGAN] Jawaban gabungan disimpan: no_urut=${noUrut}, jawaban=${jawaban}`);
    return true;
  } catch (error) {
    console.error('[GABUNGAN] Error updating jawaban gabungan:', error);
    return false;
  }
}

// Helper: Ambil semua jawaban gabungan
async function getJawabanGabungan(pid, aid) {
  try {
    const jawabanGabungan = await supabaseRequest('jawaban_gabungan', 'GET', {
      select: 'no_urut,jawaban,id_mapel,id_soal,tgljam_update',
      id_peserta: `eq.${pid}`,
      id_agenda: `eq.${aid}`,
      order: 'no_urut.asc'
    });

    return jawabanGabungan || [];
  } catch (error) {
    console.error('[GABUNGAN] Error getting jawaban gabungan:', error);
    return [];
  }
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

    // Generate mapping soal gabungan untuk agenda ini
    setTimeout(() => {
      generateSoalMapping(form.agenda_id).then(result => {
        console.log(`[REGISTER] Mapping generated: ${result.success ? 'Success' : 'Failed'}`);
      });
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

    // Dapatkan info agenda untuk token
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

// [Endpoint lainnya tetap sama seperti sebelumnya...]

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
        'id,pertanyaan,type_soal,no_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8',
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

    // Generate mapping jika belum ada
    const mappingCheck = await supabaseRequest('soal_mapping_gabungan', 'GET', {
      select: 'id',
      id_agenda: `eq.${agenda_id}`,
      limit: 1
    });

    if (!mappingCheck || mappingCheck.length === 0) {
      console.log(`[GET-SOAL] Mapping belum ada, generating...`);
      await generateSoalMapping(agenda_id);
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
 * body: { pid, aid, mid, jwb }
 * PERUBAHAN: Juga simpan ke jawaban_gabungan
 */
router.post('/save-jawaban', async (req, res) => {
  const { pid, aid, mid, jwb } = req.body || {};
  try {
    if (!pid || !aid || !mid) return res.status(400).json({ success: false, message: 'pid, aid, mid wajib' });

    // Simpan ke tabel jawaban biasa
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

    // Ambil data soal untuk mapel ini
    const soalList = await supabaseRequest('bank_soal', 'GET', {
      select: 'id,no_soal',
      id_mapel: `eq.${mid}`,
      order: 'no_soal.asc',
      limit: 500
    });

    if (soalList && soalList.length > 0) {
      const jawabanArray = jwb.split('|');
      
      // Simpan ke jawaban gabungan
      for (let i = 0; i < soalList.length; i++) {
        if (i < jawabanArray.length) {
          const soalId = soalList[i].id;
          const nomorSoal = soalList[i].no_soal || (i + 1);
          const jawabanPerSoal = jawabanArray[i] || '-';
          
          // Ambil nama mapel
          const mapelRes = await supabaseRequest('mata_pelajaran', 'GET', {
            select: 'nama_mata_pelajaran',
            id: `eq.${mid}`,
            limit: 1
          });
          
          const mapelNama = mapelRes && mapelRes.length > 0 ? mapelRes[0].nama_mata_pelajaran : 'Unknown';
          
          // Simpan ke jawaban gabungan
          await updateJawabanGabungan(
            pid, 
            aid, 
            mid, 
            soalId, 
            jawabanPerSoal, 
            nomorSoal, 
            mapelNama
          );
        }
      }
    }

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

/**
 * GET /api/jawaban-gabungan
 * Mendapatkan semua jawaban gabungan untuk peserta
 */
router.get('/jawaban-gabungan', async (req, res) => {
  const { pid, aid } = req.query || {};
  try {
    if (!pid || !aid) {
      return res.status(400).json({ success: false, message: 'pid & aid wajib' });
    }

    const jawabanGabungan = await getJawabanGabungan(pid, aid);
    
    res.json({
      success: true,
      data: jawabanGabungan,
      total: jawabanGabungan.length
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/generate-mapping
 * Generate mapping soal gabungan
 */
router.post('/generate-mapping', async (req, res) => {
  const { agenda_id } = req.body || {};
  try {
    if (!agenda_id) {
      return res.status(400).json({ success: false, message: 'agenda_id wajib' });
    }

    const result = await generateSoalMapping(agenda_id);
    
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/export-jawaban-gabungan
 * Export semua jawaban gabungan dalam format CSV/JSON
 */
router.get('/export-jawaban-gabungan', async (req, res) => {
  const { agenda_id, format = 'json' } = req.query || {};
  try {
    if (!agenda_id) {
      return res.status(400).json({ success: false, message: 'agenda_id wajib' });
    }

    // Ambil semua peserta untuk agenda ini
    const pesertaList = await supabaseRequest('peserta', 'GET', {
      select: 'id,nama_peserta,nis_username,kelas,asal_sekolah',
      id_agenda: `eq.${agenda_id}`,
      status: `eq.Aktif`
    });

    if (!pesertaList || pesertaList.length === 0) {
      return res.json({ success: true, data: [], message: 'Tidak ada peserta' });
    }

    const result = [];
    
    for (const peserta of pesertaList) {
      const jawabanGabungan = await getJawabanGabungan(peserta.id, agenda_id);
      
      const pesertaData = {
        id_peserta: peserta.id,
        nama_peserta: peserta.nama_peserta,
        nis_username: peserta.nis_username,
        kelas: peserta.kelas,
        asal_sekolah: peserta.asal_sekolah,
        jawaban: {}
      };

      // Format jawaban berdasarkan nomor urut
      jawabanGabungan.forEach(item => {
        pesertaData.jawaban[`soal_${item.no_urut}`] = item.jawaban;
      });

      result.push(pesertaData);
    }

    if (format === 'csv') {
      // Generate CSV
      if (result.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="jawaban_gabungan.csv"');
        return res.send('Nama,NIS,Kelas,Sekolah\n');
      }

      // Ambil jumlah soal maksimal
      const maxSoal = Math.max(...result.map(p => Object.keys(p.jawaban).length));
      
      let csv = 'Nama,NIS,Kelas,Sekolah';
      for (let i = 1; i <= maxSoal; i++) {
        csv += `,Soal ${i}`;
      }
      csv += '\n';

      result.forEach(peserta => {
        csv += `"${peserta.nama_peserta}","${peserta.nis_username}","${peserta.kelas}","${peserta.asal_sekolah}"`;
        for (let i = 1; i <= maxSoal; i++) {
          const jawaban = peserta.jawaban[`soal_${i}`] || '-';
          csv += `,"${jawaban}"`;
        }
        csv += '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="jawaban_gabungan.csv"');
      return res.send(csv);
    }

    // Default: JSON
    res.json({
      success: true,
      agenda_id: agenda_id,
      total_peserta: result.length,
      data: result
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/health
 * Endpoint untuk cek kesehatan server
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server berjalan dengan baik',
    timestamp: new Date().toISOString(),
    features: {
      jawaban_gabungan: 'Aktif',
      mapping_soal: 'Aktif'
    },
    env: {
      supabase_url: SUPABASE_URL ? 'Terisi' : 'Kosong',
      node_env: process.env.NODE_ENV || 'development'
    }
  });
});

app.use('/api', router);

// Handler untuk route yang tidak ditemukan
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
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

// Local run (tidak dipakai di Vercel serverless)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Server CBT Ujian Online`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`📅 ${new Date().toLocaleString('id-ID')}`);
    console.log(`🌐 Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✅ Health check: http://localhost:${PORT}/api/health`);
    console.log(`✅ Jawaban Gabungan: Aktif`);
    console.log(`========================================`);
  });
}

module.exports = app;
