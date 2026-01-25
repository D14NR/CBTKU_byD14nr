'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Environment variables (sama dengan file utama)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ============================================
// HELPER FUNCTIONS (Copy dari api/index.js)
// ============================================

/**
 * Helper: request ke Supabase REST
 * SAMA PERSIS dengan fungsi di api/index.js
 */
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

/**
 * Safe user - hapus password dari response
 */
function safeUser(u) {
  if (!u) return u;
  const copy = { ...u };
  delete copy.password;
  return copy;
}

// ============================================
// OFFLINE MODE SPECIFIC FUNCTIONS
// ============================================

/**
 * Hash sederhana untuk validasi offline
 */
function createSimpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

/**
 * Checksum untuk validasi integritas jawaban
 */
function createAnswersChecksum(answers) {
  const str = JSON.stringify(answers);
  return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * Kompres package data (remove whitespace)
 */
function compressPackageData(packageData) {
  return {
    // Agenda data
    a: {
      i: packageData.agenda.id,
      n: packageData.agenda.agenda_ujian,
      t: packageData.agenda.token_ujian,
      s: packageData.agenda.tgljam_mulai,
      e: packageData.agenda.tgljam_selesai,
      d: packageData.agenda.durasi_ujian
    },
    
    // Mapel list
    m: packageData.mapel_list.map(mapel => ({
      i: mapel.id,
      n: mapel.nama_mata_pelajaran,
      d: mapel.durasi_ujian,
      j: mapel.jumlah_soal
    })),
    
    // Questions by mapel (compressed)
    q: Object.keys(packageData.questions_by_mapel).reduce((acc, mapelId) => {
      acc[mapelId] = packageData.questions_by_mapel[mapelId].map(q => ({
        i: q.id,
        n: q.no_soal,
        t: q.type_soal,
        p: q.pertanyaan,
        u: q.gambar_url,
        a: q.pilihan_a,
        b: q.pilihan_b,
        c: q.pilihan_c,
        d: q.pilihan_d,
        e: q.pilihan_e,
        // Pernyataan untuk tipe soal tertentu
        p1: q.pernyataan_1, p2: q.pernyataan_2, p3: q.pernyataan_3, p4: q.pernyataan_4,
        p5: q.pernyataan_5, p6: q.pernyataan_6, p7: q.pernyataan_7, p8: q.pernyataan_8,
        // Penjodohan
        l1: q.pernyataan_kiri_1, l2: q.pernyataan_kiri_2, l3: q.pernyataan_kiri_3, l4: q.pernyataan_kiri_4,
        l5: q.pernyataan_kiri_5, l6: q.pernyataan_kiri_6, l7: q.pernyataan_kiri_7, l8: q.pernyataan_kiri_8,
        r1: q.pernyataan_kanan_1, r2: q.pernyataan_kanan_2, r3: q.pernyataan_kanan_3, r4: q.pernyataan_kanan_4,
        r5: q.pernyataan_kanan_5, r6: q.pernyataan_kanan_6, r7: q.pernyataan_kanan_7, r8: q.pernyataan_kanan_8
      }));
      return acc;
    }, {}),
    
    // Participants for offline validation
    p: packageData.peserta_list.map(user => ({
      i: user.id,
      u: user.username,
      h: user.password_hash,
      n: user.nama
    })),
    
    // Metadata
    meta: {
      v: '1.0',
      ts: new Date().toISOString(),
      exp: packageData.agenda.tgljam_selesai
    }
  };
}

/**
 * Decompress package data
 */
function decompressPackageData(compressed) {
  return {
    agenda: {
      id: compressed.a.i,
      agenda_ujian: compressed.a.n,
      token_ujian: compressed.a.t,
      tgljam_mulai: compressed.a.s,
      tgljam_selesai: compressed.a.e,
      durasi_ujian: compressed.a.d
    },
    mapel_list: compressed.m.map(mapel => ({
      id: mapel.i,
      nama_mata_pelajaran: mapel.n,
      durasi_ujian: mapel.d,
      jumlah_soal: mapel.j
    })),
    questions_by_mapel: Object.keys(compressed.q).reduce((acc, mapelId) => {
      acc[mapelId] = compressed.q[mapelId].map(q => ({
        id: q.i,
        no_soal: q.n,
        type_soal: q.t,
        pertanyaan: q.p,
        gambar_url: q.u,
        pilihan_a: q.a,
        pilihan_b: q.b,
        pilihan_c: q.c,
        pilihan_d: q.d,
        pilihan_e: q.e,
        pernyataan_1: q.p1, pernyataan_2: q.p2, pernyataan_3: q.p3, pernyataan_4: q.p4,
        pernyataan_5: q.p5, pernyataan_6: q.p6, pernyataan_7: q.p7, pernyataan_8: q.p8,
        pernyataan_kiri_1: q.l1, pernyataan_kiri_2: q.l2, pernyataan_kiri_3: q.l3, pernyataan_kiri_4: q.l4,
        pernyataan_kiri_5: q.l5, pernyataan_kiri_6: q.l6, pernyataan_kiri_7: q.l7, pernyataan_kiri_8: q.l8,
        pernyataan_kanan_1: q.r1, pernyataan_kanan_2: q.r2, pernyataan_kanan_3: q.r3, pernyataan_kanan_4: q.r4,
        pernyataan_kanan_5: q.r5, pernyataan_kanan_6: q.r6, pernyataan_kanan_7: q.r7, pernyataan_kanan_8: q.r8
      }));
      return acc;
    }, {}),
    peserta_list: compressed.p.map(user => ({
      id: user.i,
      username: user.u,
      password_hash: user.h,
      nama: user.n
    }))
  };
}

// ============================================
// API ENDPOINTS OFFLINE MODE
// ============================================

/**
 * GET /api-offline/exam-package/:agenda_id
 * Download SEMUA data untuk offline usage
 */
router.get('/exam-package/:agenda_id', async (req, res) => {
  try {
    const { agenda_id } = req.params;
    
    console.log(`[OFFLINE-PACKAGE] Download request for agenda: ${agenda_id}`);
    
    // 1. Get agenda details
    const agendaRes = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'id,agenda_ujian,tgljam_mulai,tgljam_selesai,token_ujian,durasi_ujian',
      id: `eq.${agenda_id}`,
      limit: 1
    });
    
    if (!agendaRes || agendaRes.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Agenda tidak ditemukan' 
      });
    }
    
    const agenda = agendaRes[0];
    
    // Check if agenda is still active
    const now = new Date();
    const endTime = new Date(agenda.tgljam_selesai);
    
    if (now > endTime) {
      return res.status(400).json({ 
        success: false, 
        message: 'Agenda sudah berakhir' 
      });
    }
    
    // 2. Get all mapel for this agenda
    const mapelRes = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id,nama_mata_pelajaran,jumlah_soal,durasi_ujian',
      id_agenda: `eq.${agenda_id}`,
      status_mapel: 'eq.Siap',
      order: 'id.asc'
    });
    
    const mapelList = mapelRes || [];
    
    // 3. Get ALL questions for all mapel (BATCH)
    const questionsByMapel = {};
    const imageUrls = new Set();
    
    // Get all mapel IDs
    const mapelIds = mapelList.map(m => m.id);
    
    if (mapelIds.length > 0) {
      // Get questions in batches
      for (let i = 0; i < mapelIds.length; i += 5) { // 5 mapel per batch
        const batchIds = mapelIds.slice(i, i + 5);
        
        // Use IN query untuk efisiensi
        const questionsRes = await supabaseRequest('bank_soal', 'GET', {
          select: 'id,pertanyaan,type_soal,no_soal,pilihan_a,pilihan_b,pilihan_c,pilihan_d,pilihan_e,gambar_url,pernyataan_1,pernyataan_2,pernyataan_3,pernyataan_4,pernyataan_5,pernyataan_6,pernyataan_7,pernyataan_8,pernyataan_kiri_1,pernyataan_kiri_2,pernyataan_kiri_3,pernyataan_kiri_4,pernyataan_kiri_5,pernyataan_kiri_6,pernyataan_kiri_7,pernyataan_kiri_8,pernyataan_kanan_1,pernyataan_kanan_2,pernyataan_kanan_3,pernyataan_kanan_4,pernyataan_kanan_5,pernyataan_kanan_6,pernyataan_kanan_7,pernyataan_kanan_8,id_mapel',
          id_mapel: `in.(${batchIds.join(',')})`,
          order: 'id_mapel,no_soal.asc',
          limit: 1000
        });
        
        // Group questions by mapel
        if (questionsRes) {
          questionsRes.forEach(question => {
            const mapelId = question.id_mapel;
            if (!questionsByMapel[mapelId]) {
              questionsByMapel[mapelId] = [];
            }
            
            // Remove id_mapel from question object
            delete question.id_mapel;
            
            questionsByMapel[mapelId].push(question);
            
            // Collect image URLs for preloading
            if (question.gambar_url && question.gambar_url.trim() !== '') {
              imageUrls.add(question.gambar_url);
            }
          });
        }
      }
    }
    
    // 4. Get all participants for offline validation
    const pesertaRes = await supabaseRequest('peserta', 'GET', {
      select: 'id,nama_peserta,nis_username,password,kelas,asal_sekolah',
      id_agenda: `eq.${agenda_id}`,
      status: 'eq.Aktif',
      limit: 1000
    });
    
    const pesertaList = (pesertaRes || []).map(p => ({
      id: p.id,
      nama: p.nama_peserta,
      username: p.nis_username,
      password_hash: createSimpleHash(p.nis_username + p.password),
      kelas: p.kelas,
      sekolah: p.asal_sekolah
    }));
    
    // 5. Build package data
    const packageData = {
      agenda: agenda,
      mapel_list: mapelList,
      questions_by_mapel: questionsByMapel,
      peserta_list: pesertaList,
      image_urls: Array.from(imageUrls),
      metadata: {
        package_version: '1.0',
        generated_at: new Date().toISOString(),
        valid_until: agenda.tgljam_selesai,
        total_mapel: mapelList.length,
        total_questions: Object.values(questionsByMapel).reduce((sum, q) => sum + q.length, 0),
        total_images: imageUrls.size
      }
    };
    
    // 6. Create compressed and uncompressed versions
    const compressed = compressPackageData(packageData);
    const uncompressedSize = JSON.stringify(packageData).length;
    const compressedSize = JSON.stringify(compressed).length;
    const compressionRatio = Math.round((1 - compressedSize/uncompressedSize) * 100);
    
    console.log(`[OFFLINE-PACKAGE] Generated: ${packageData.metadata.total_questions} soal, ${packageData.metadata.total_images} gambar`);
    console.log(`[OFFLINE-PACKAGE] Size: ${uncompressedSize} → ${compressedSize} bytes (${compressionRatio}% smaller)`);
    
    // 7. Response
    res.json({
      success: true,
      data: compressed, // Kirim versi compressed
      metadata: {
        ...packageData.metadata,
        uncompressed_size: uncompressedSize,
        compressed_size: compressedSize,
        compression_ratio: compressionRatio
      },
      // Include agenda name for display
      agenda_name: agenda.agenda_ujian,
      download_time: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[OFFLINE-PACKAGE] Error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      code: 'PACKAGE_GENERATION_ERROR'
    });
  }
});

/**
 * POST /api-offline/validate-package-access
 * Validasi user akses ke package (sebelum download)
 */
router.post('/validate-package-access', async (req, res) => {
  const { agenda_id, user_id, username } = req.body;
  
  try {
    if (!agenda_id || (!user_id && !username)) {
      return res.status(400).json({ 
        success: false, 
        message: 'agenda_id dan user_id/username diperlukan' 
      });
    }
    
    // Check if user has access to this agenda
    let userRes;
    
    if (user_id) {
      userRes = await supabaseRequest('peserta', 'GET', {
        select: 'id,id_agenda,status',
        id: `eq.${user_id}`,
        limit: 1
      });
    } else if (username) {
      userRes = await supabaseRequest('peserta', 'GET', {
        select: 'id,id_agenda,status',
        nis_username: `eq.${username}`,
        limit: 1
      });
    }
    
    if (!userRes || userRes.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'User tidak ditemukan' 
      });
    }
    
    const user = userRes[0];
    
    // Check if user is active
    if (user.status !== 'Aktif') {
      return res.status(403).json({ 
        success: false, 
        message: 'Akun tidak aktif' 
      });
    }
    
    // Check if user belongs to this agenda
    if (parseInt(user.id_agenda) !== parseInt(agenda_id)) {
      return res.status(403).json({ 
        success: false, 
        message: 'User tidak terdaftar di agenda ini' 
      });
    }
    
    // Check agenda availability
    const agendaRes = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'tgljam_mulai,tgljam_selesai',
      id: `eq.${agenda_id}`,
      limit: 1
    });
    
    if (!agendaRes || agendaRes.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Agenda tidak ditemukan' 
      });
    }
    
    const agenda = agendaRes[0];
    const now = new Date();
    const startTime = new Date(agenda.tgljam_mulai);
    const endTime = new Date(agenda.tgljam_selesai);
    
    let status = 'available';
    let message = 'Package tersedia';
    
    if (now < startTime) {
      status = 'not_started';
      message = 'Agenda belum dimulai';
    } else if (now > endTime) {
      status = 'ended';
      message = 'Agenda sudah berakhir';
    }
    
    res.json({
      success: true,
      valid: status === 'available',
      status: status,
      message: message,
      user_id: user.id,
      agenda_id: parseInt(agenda_id),
      timeline: {
        now: now.toISOString(),
        starts_at: agenda.tgljam_mulai,
        ends_at: agenda.tgljam_selesai,
        starts_in: startTime - now,
        ends_in: endTime - now
      }
    });
    
  } catch (error) {
    console.error('[VALIDATE-ACCESS] Error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * POST /api-offline/submit-batch
 * Submit semua jawaban sekaligus (BATCH)
 */
router.post('/submit-batch', async (req, res) => {
  const { 
    user_id, 
    agenda_id, 
    mapel_id, 
    answers, // Format: {questionId: answer}
    session_data,
    device_info,
    checksum 
  } = req.body;
  
  try {
    console.log(`[SUBMIT-BATCH] Received from user ${user_id}, mapel ${mapel_id}, ${Object.keys(answers).length} answers`);
    
    // 1. Validasi data wajib
    if (!user_id || !agenda_id || !mapel_id || !answers) {
      return res.status(400).json({ 
        success: false, 
        message: 'Data tidak lengkap' 
      });
    }
    
    // 2. Validasi checksum
    const expectedChecksum = createAnswersChecksum(answers);
    if (checksum && checksum !== expectedChecksum) {
      return res.status(400).json({ 
        success: false, 
        message: 'Integritas data jawaban tidak valid',
        expected: expectedChecksum,
        received: checksum
      });
    }
    
    // 3. Cek apakah sudah pernah submit
    const existingRes = await supabaseRequest('jawaban', 'GET', {
      select: 'id,status,jawaban',
      id_peserta: `eq.${user_id}`,
      id_mapel: `eq.${mapel_id}`,
      id_agenda: `eq.${agenda_id}`,
      limit: 1
    });
    
    // 4. Get metadata untuk snapshot
    const [userRes, agendaRes, mapelRes] = await Promise.all([
      supabaseRequest('peserta', 'GET', { 
        select: 'nama_peserta', 
        id: `eq.${user_id}`, 
        limit: 1 
      }),
      supabaseRequest('agenda_ujian', 'GET', { 
        select: 'agenda_ujian', 
        id: `eq.${agenda_id}`, 
        limit: 1 
      }),
      supabaseRequest('mata_pelajaran', 'GET', { 
        select: 'nama_mata_pelajaran', 
        id: `eq.${mapel_id}`, 
        limit: 1 
      })
    ]);
    
    // 5. Convert answers object ke string format
    const jawabanArray = Object.entries(answers).map(([questionId, answer]) => 
      `${questionId}:${answer}`
    );
    const jawabanString = jawabanArray.join('|');
    
    // 6. Hitung statistik
    const totalSoal = Object.keys(answers).length;
    const answered = Object.values(answers).filter(a => a && a !== '-').length;
    const percentage = totalSoal > 0 ? Math.round((answered / totalSoal) * 100) : 0;
    
    // 7. Siapkan payload untuk database
    const payload = {
      id_peserta: parseInt(user_id),
      id_agenda: parseInt(agenda_id),
      id_mapel: parseInt(mapel_id),
      nama_peserta_snap: userRes?.[0]?.nama_peserta || '-',
      nama_agenda_snap: agendaRes?.[0]?.agenda_ujian || '-',
      nama_mapel_snap: mapelRes?.[0]?.nama_mata_pelajaran || '-',
      jawaban: jawabanString,
      tgljam_login: session_data?.start_time ? new Date(session_data.start_time).toISOString() : new Date().toISOString(),
      tgljam_mulai: session_data?.start_time ? new Date(session_data.start_time).toISOString() : new Date().toISOString(),
      tgljam_selesai: new Date().toISOString(),
      status: 'Selesai',
      durasi_digunakan: session_data?.duration_used || 0,
      device_info: device_info || null,
      submitted_via: 'offline-batch',
      submitted_at: new Date().toISOString(),
      statistik: JSON.stringify({
        total_soal: totalSoal,
        dijawab: answered,
        persentase: percentage,
        session_duration: session_data?.duration_used || 0,
        timestamp: new Date().toISOString()
      })
    };
    
    // 8. Simpan atau update ke database
    let result;
    
    if (existingRes && existingRes.length > 0) {
      const existing = existingRes[0];
      
      // Jangan overwrite jika sudah selesai
      if (existing.status === 'Selesai') {
        return res.json({
          success: true,
          already_submitted: true,
          message: 'Jawaban sudah pernah disubmit sebelumnya',
          previous_submission: existing.tgljam_selesai
        });
      }
      
      // Update existing record
      result = await supabaseRequest('jawaban', 'PATCH', {
        id: `eq.${existing.id}`
      }, payload);
      
    } else {
      // Insert new record
      result = await supabaseRequest('jawaban', 'POST', null, payload);
    }
    
    console.log(`[SUBMIT-BATCH] Success for user ${user_id}: ${answered}/${totalSoal} answered (${percentage}%)`);
    
    // 9. Response sukses
    res.json({
      success: true,
      submitted_at: new Date().toISOString(),
      submission_id: result?.[0]?.id || 'unknown',
      statistik: {
        total: totalSoal,
        dijawab: answered,
        persentase: percentage,
        duration: payload.durasi_digunakan
      },
      message: 'Jawaban berhasil disimpan',
      metadata: {
        user_id: parseInt(user_id),
        agenda_id: parseInt(agenda_id),
        mapel_id: parseInt(mapel_id),
        answers_count: totalSoal
      }
    });
    
  } catch (error) {
    console.error('[SUBMIT-BATCH] Error:', error);
    
    // Catat error untuk retry nanti
    await logFailedSubmission({
      user_id, agenda_id, mapel_id, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Gagal menyimpan jawaban',
      error: error.message,
      queued: true // Flag untuk client agar coba lagi nanti
    });
  }
});

/**
 * POST /api-offline/sync-answers
 * Sync jawaban incremental (untuk auto-save)
 */
router.post('/sync-answers', async (req, res) => {
  const { 
    user_id, 
    agenda_id, 
    mapel_id, 
    answers, // {questionId: answer}
    sync_token 
  } = req.body;
  
  try {
    // Validasi
    if (!user_id || !agenda_id || !mapel_id || !answers) {
      return res.status(400).json({ 
        success: false, 
        message: 'Data tidak lengkap' 
      });
    }
    
    console.log(`[SYNC-ANSWERS] Syncing ${Object.keys(answers).length} answers from user ${user_id}`);
    
    // 1. Cek existing jawaban
    const existingRes = await supabaseRequest('jawaban', 'GET', {
      select: 'id,jawaban,status',
      id_peserta: `eq.${user_id}`,
      id_mapel: `eq.${mapel_id}`,
      id_agenda: `eq.${agenda_id}`,
      limit: 1
    });
    
    let finalJawaban = '';
    
    if (existingRes && existingRes.length > 0) {
      const existing = existingRes[0];
      
      // Jika sudah selesai, jangan update
      if (existing.status === 'Selesai') {
        return res.json({
          success: true,
          synced: false,
          reason: 'Ujian sudah selesai'
        });
      }
      
      // Parse existing jawaban
      const existingMap = {};
      if (existing.jawaban) {
        existing.jawaban.split('|').forEach(entry => {
          const [qId, ans] = entry.split(':');
          if (qId && ans) {
            existingMap[qId] = ans;
          }
        });
      }
      
      // Merge dengan jawaban baru
      Object.assign(existingMap, answers);
      
      // Convert back to string
      finalJawaban = Object.entries(existingMap)
        .map(([qId, ans]) => `${qId}:${ans}`)
        .join('|');
      
    } else {
      // Create new jawaban string
      finalJawaban = Object.entries(answers)
        .map(([qId, ans]) => `${qId}:${ans}`)
        .join('|');
    }
    
    // 2. Update atau insert
    if (existingRes && existingRes.length > 0) {
      // Update existing
      await supabaseRequest('jawaban', 'PATCH', {
        id_peserta: `eq.${user_id}`,
        id_mapel: `eq.${mapel_id}`,
        id_agenda: `eq.${agenda_id}`
      }, {
        jawaban: finalJawaban,
        last_sync: new Date().toISOString()
      });
    } else {
      // Insert baru
      const [userRes, agendaRes, mapelRes] = await Promise.all([
        supabaseRequest('peserta', 'GET', { 
          select: 'nama_peserta', 
          id: `eq.${user_id}`, 
          limit: 1 
        }),
        supabaseRequest('agenda_ujian', 'GET', { 
          select: 'agenda_ujian', 
          id: `eq.${agenda_id}`, 
          limit: 1 
        }),
        supabaseRequest('mata_pelajaran', 'GET', { 
          select: 'nama_mata_pelajaran', 
          id: `eq.${mapel_id}`, 
          limit: 1 
        })
      ]);
      
      await supabaseRequest('jawaban', 'POST', null, {
        id_peserta: parseInt(user_id),
        id_agenda: parseInt(agenda_id),
        id_mapel: parseInt(mapel_id),
        nama_peserta_snap: userRes?.[0]?.nama_peserta || '-',
        nama_agenda_snap: agendaRes?.[0]?.agenda_ujian || '-',
        nama_mapel_snap: mapelRes?.[0]?.nama_mata_pelajaran || '-',
        jawaban: finalJawaban,
        tgljam_login: new Date().toISOString(),
        tgljam_mulai: new Date().toISOString(),
        status: 'Proses',
        last_sync: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      synced: true,
      synced_at: new Date().toISOString(),
      answers_count: Object.keys(answers).length,
      message: 'Jawaban berhasil disinkronisasi'
    });
    
  } catch (error) {
    console.error('[SYNC-ANSWERS] Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Gagal sinkronisasi',
      error: error.message
    });
  }
});

/**
 * GET /api-offline/health
 * Health check untuk offline mode
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'offline-mode-api',
    status: 'operational',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    features: [
      'exam-package-download',
      'batch-submission',
      'answer-sync',
      'offline-validation'
    ],
    limits: {
      max_package_size: '5MB',
      max_answers_per_batch: 1000,
      rate_limit: '100 req/min'
    }
  });
});

/**
 * POST /api-offline/validate-offline-token
 * Validasi token secara offline (untuk client-side validation)
 */
router.post('/validate-offline-token', async (req, res) => {
  const { agenda_id, token } = req.body;
  
  try {
    if (!agenda_id || !token) {
      return res.status(400).json({ 
        success: false, 
        message: 'agenda_id dan token diperlukan' 
      });
    }
    
    const agendaRes = await supabaseRequest('agenda_ujian', 'GET', {
      select: 'token_ujian,tgljam_mulai,tgljam_selesai',
      id: `eq.${agenda_id}`,
      limit: 1
    });
    
    if (!agendaRes || agendaRes.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Agenda tidak ditemukan' 
      });
    }
    
    const agenda = agendaRes[0];
    
    // Validasi token
    const isValidToken = agenda.token_ujian?.trim().toUpperCase() === token.trim().toUpperCase();
    
    // Validasi waktu
    const now = new Date();
    const startTime = new Date(agenda.tgljam_mulai);
    const endTime = new Date(agenda.tgljam_selesai);
    
    let timeStatus = 'valid';
    if (now < startTime) {
      timeStatus = 'not_started';
    } else if (now > endTime) {
      timeStatus = 'ended';
    }
    
    res.json({
      success: true,
      token_valid: isValidToken,
      time_status: timeStatus,
      agenda_time: {
        start: agenda.tgljam_mulai,
        end: agenda.tgljam_selesai,
        now: now.toISOString()
      },
      message: isValidToken ? 'Token valid' : 'Token tidak valid'
    });
    
  } catch (error) {
    console.error('[VALIDATE-OFFLINE-TOKEN] Error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * POST /api-offline/get-image-urls
 * Dapatkan daftar URL gambar untuk preloading
 */
router.post('/get-image-urls', async (req, res) => {
  const { agenda_id } = req.body;
  
  try {
    if (!agenda_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'agenda_id diperlukan' 
      });
    }
    
    // Get all mapels for this agenda
    const mapelRes = await supabaseRequest('mata_pelajaran', 'GET', {
      select: 'id',
      id_agenda: `eq.${agenda_id}`,
      status_mapel: 'eq.Siap',
      limit: 50
    });
    
    const mapelIds = (mapelRes || []).map(m => m.id);
    
    if (mapelIds.length === 0) {
      return res.json({
        success: true,
        image_urls: [],
        count: 0
      });
    }
    
    // Get image URLs from questions
    const imageUrls = new Set();
    
    // Batch query untuk efisiensi
    for (let i = 0; i < mapelIds.length; i += 10) {
      const batchIds = mapelIds.slice(i, i + 10);
      
      const questionsRes = await supabaseRequest('bank_soal', 'GET', {
        select: 'gambar_url',
        id_mapel: `in.(${batchIds.join(',')})`,
        gambar_url: 'not.is.null',
        limit: 500
      });
      
      if (questionsRes) {
        questionsRes.forEach(q => {
          if (q.gambar_url && q.gambar_url.trim() !== '') {
            imageUrls.add(q.gambar_url);
          }
        });
      }
    }
    
    res.json({
      success: true,
      image_urls: Array.from(imageUrls),
      count: imageUrls.size,
      estimated_size: imageUrls.size * 50000, // Estimasi 50KB per gambar
      agenda_id: parseInt(agenda_id)
    });
    
  } catch (error) {
    console.error('[GET-IMAGE-URLS] Error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ============================================
// HELPER FUNCTIONS (INTERNAL)
// ============================================

/**
 * Log failed submissions untuk retry nanti
 */
async function logFailedSubmission(data) {
  try {
    // Simpan ke tabel khusus atau console
    console.error('[FAILED-SUBMISSION]', data);
    
    // Bisa juga simpan ke database untuk retry manual
    await supabaseRequest('failed_submissions', 'POST', null, {
      ...data,
      retry_count: 0,
      status: 'pending',
      created_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[LOG-FAILED-SUBMISSION] Error:', error);
  }
}

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================

// Error handler untuk offline mode
router.use((err, req, res, next) => {
  console.error('[OFFLINE-API-ERROR]', err);
  
  // Custom error responses
  const errorResponse = {
    success: false,
    message: err.message || 'Terjadi kesalahan',
    code: err.code || 'INTERNAL_ERROR',
    timestamp: new Date().toISOString(),
    path: req.path
  };
  
  // Tambahkan stack trace di development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.stack = err.stack;
  }
  
  res.status(err.status || 500).json(errorResponse);
});

// 404 handler
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Endpoint ${req.originalUrl} tidak ditemukan`,
    available_endpoints: [
      'GET  /exam-package/:agenda_id',
      'POST /validate-package-access',
      'POST /submit-batch',
      'POST /sync-answers',
      'GET  /health',
      'POST /validate-offline-token',
      'POST /get-image-urls'
    ]
  });
});

// ============================================
// EXPORT ROUTER
// ============================================

module.exports = router;
